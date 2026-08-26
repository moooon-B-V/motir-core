import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRepo, type LinkConfig, type RepoResolutionSource } from './config/linkConfig.js';
import { execCommand, type CommandRunner } from './git.js';
import type { ProjectRepository } from './client.js';

// MATERIALIZING the project's repository set (Story MOTIR-3584 · Subtask
// MOTIR-3587) — the PURE half. Given the set the server published and the
// link's own resolution, decide ONE outcome per repository; the runner below
// executes only the `clone` decisions, through an injected `CommandRunner`.
//
// The split mirrors `dispatch.ts` (pure routing) / `commands/dispatch.ts` (the
// I/O), and for the same reason: the whole matrix — which rows are materialized,
// what an existing path does, where an override sends a clone — is unit-testable
// with no git process, no network and no filesystem.
//
// `docs/decisions/link-materializes-the-checkouts.md` decides every branch here,
// and this module implements it rather than re-arguing it:
//
//   §1  clone by DEFAULT; `--no-clone` suppresses all filesystem work.
//   §2  materialize exactly the ESTABLISHED rows that have a clone URL.
//   §3  the USER's own git credential — we shell out to `git clone` and nothing
//       of Motir's rides along.
//   §4  a FULL clone. No `--depth`, no `--filter`, no `--single-branch`.
//   §5  NEVER write into an existing path — and, the stronger form the guard can
//       actually hold, never issue ANY git command for a repository whose
//       resolved path exists.
//   §6  clone to the path `resolveRepo` returns, override or convention alike.

/** What was DECIDED for one repository, before anything ran. */
export type RepoClonePlanKind =
  /** Missing, materializable — the one kind the runner acts on. */
  | 'clone'
  /** The resolved path already exists. Untouched, whatever is in it (§5). */
  | 'present'
  /** Not materializable, and nothing is wrong: the row names no repository yet,
   *  or names one whose provider this build cannot address (§2). */
  | 'skip';

/** WHY a row was skipped — the sentence the report prints beside it. */
export type RepoCloneSkipReason =
  /** The row is not ESTABLISHED: `proposed` / `creating` / `skipped` / `failed`,
   *  or a settled row whose repository has since been disconnected. */
  | 'not_established'
  /** ESTABLISHED, but `cloneUrl` is null — a provider this build cannot address.
   *  `repoCloneUrl` returns null there deliberately, and guessing a host would
   *  hand git a URL that fails. */
  | 'no_clone_url';

/** One planned outcome. Every kind carries the same identity fields, so the
 *  report is one shape however a row was disposed of. */
export interface RepoClonePlanEntry {
  /** How the report NAMES this row. The checkout name when the row has one; the
   *  role (plus its label) when it does not, because an unestablished row has no
   *  checkout name and must still be legible. */
  label: string;
  /** The row's establish state, printed beside a skip so `proposed` reads as
   *  "not created yet" rather than as a failure. */
  state: string;
  kind: RepoClonePlanKind;
  /** Where the checkout resolves — null only when the row has no checkout name
   *  to resolve, which is exactly the `not_established` case. */
  path: string | null;
  /** How `path` was resolved (§6), or null when there is none. */
  source: RepoResolutionSource | null;
  /** The URL a `clone` will use. Null on every other kind. */
  cloneUrl: string | null;
  /** Whether the repository is archived on the host — cloned anyway, and said
   *  (§2); refusing to BRANCH on one belongs to dispatch. */
  archived: boolean;
  /** Set on `skip` only. */
  skipReason: RepoCloneSkipReason | null;
  /** Set on `present` only: whether the existing path is a git repository at
   *  all. Answered from the FILESYSTEM (`<path>/.git`), never by running git —
   *  see §5's note on why the invariant is worth more than the refinement. */
  presentIsRepository: boolean | null;
}

export interface PlanRepoClonesOptions {
  /** Injectable path-existence predicate (the tests' seam), as `dispatch.ts`. */
  exists?: (path: string) => boolean;
}

/** How a row is NAMED when it has no checkout name of its own. */
function roleLabel(repo: ProjectRepository): string {
  return repo.label ? `${repo.role} (${repo.label})` : repo.role;
}

/**
 * Decide one outcome per repository of the set, in the order the server sent
 * them (primary first).
 *
 * TOTAL over the set: every row the server published appears in the plan,
 * including the ones nothing will be done to. A report that silently dropped the
 * `proposed` rows would answer "which repositories does this project have?" with
 * a list that quietly excludes the ones the reader is most likely asking about
 * (§2).
 */
export function planRepoClones(
  rootDir: string,
  config: LinkConfig,
  repos: readonly ProjectRepository[],
  opts: PlanRepoClonesOptions = {},
): RepoClonePlanEntry[] {
  const exists = opts.exists ?? existsSync;

  return repos.map((repo): RepoClonePlanEntry => {
    const base = {
      state: repo.state,
      archived: repo.archived,
      skipReason: null,
      presentIsRepository: null,
    };

    // ⚠️ `established`, not `realizedRepo !== null` — the server publishes the
    // two-part discriminator precisely so no client re-derives it (§2).
    if (!repo.established || repo.name === null) {
      return {
        ...base,
        label: roleLabel(repo),
        kind: 'skip',
        path: null,
        source: null,
        cloneUrl: null,
        skipReason: 'not_established',
      };
    }

    // The checkout name is the REALIZED repository's own casing, which is what
    // `resolveRepo` keys `<root>/<name>` on and what a `targetRepo` pin stores.
    const resolved = resolveRepo(rootDir, config, repo.name);

    if (exists(resolved.path)) {
      return {
        ...base,
        label: repo.name,
        kind: 'present',
        path: resolved.path,
        source: resolved.source,
        cloneUrl: repo.cloneUrl,
        // From the filesystem alone. No git command is issued for an existing
        // path — that is the invariant, and it is what the guard asserts.
        presentIsRepository: exists(join(resolved.path, '.git')),
      };
    }

    if (repo.cloneUrl === null) {
      return {
        ...base,
        label: repo.name,
        kind: 'skip',
        path: resolved.path,
        source: resolved.source,
        cloneUrl: null,
        skipReason: 'no_clone_url',
      };
    }

    return {
      ...base,
      label: repo.name,
      kind: 'clone',
      path: resolved.path,
      source: resolved.source,
      cloneUrl: repo.cloneUrl,
    };
  });
}

/** What actually HAPPENED to one repository. */
export type RepoCloneStatus = 'cloned' | 'present' | 'skipped' | 'failed';

export interface RepoCloneOutcome {
  label: string;
  status: RepoCloneStatus;
  path: string | null;
  /** The line printed under the row: what was done, or why it was not. */
  detail: string;
  /** git's OWN message, kept verbatim on a failure and never replaced by ours
   *  (`packages/cli/src/errors.ts` records what discarding it costs). */
  gitMessage: string | null;
}

/** Whether git's output reads as an AUTHENTICATION refusal rather than some
 *  other failure. GitHub reports a private repository the caller cannot see as
 *  `Repository not found`, so that phrase belongs here too — it is the shape a
 *  pending collaborator invitation actually takes (ADR §3). */
function looksLikeAuthRefusal(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('authentication failed') ||
    m.includes('could not read username') ||
    m.includes('permission denied') ||
    m.includes('repository not found') ||
    m.includes('access denied') ||
    m.includes('terminal prompts disabled')
  );
}

/**
 * The message a REFUSED clone prints (ADR §3).
 *
 * Three properties are load-bearing: it names the repository AND the resolved
 * path, it names the pending-collaborator-invitation case IN WORDS, and it keeps
 * git's own sentence. The third is why this returns a message rather than
 * replacing one — a repository Motir created is private in Motir's own org, and
 * GitHub answers `Repository not found` for it, which reads as *the repository
 * does not exist* when the truth is *your account has not accepted its
 * invitation yet*.
 */
export function cloneRefusalDetail(cloneUrl: string): string {
  return (
    `could not clone: authentication failed for ${cloneUrl}\n` +
    '  If Motir created this repository it is PRIVATE, and your GitHub account has to\n' +
    '  accept its collaborator invitation before you can clone it — check Settings →\n' +
    '  Project → Repositories in Motir. Otherwise confirm which account your git\n' +
    '  credential uses (`gh auth status`).'
  );
}

/** The human sentence for a planned entry that will not be cloned. */
export function planDetail(entry: RepoClonePlanEntry): string {
  switch (entry.kind) {
    case 'present':
      return entry.presentIsRepository === false
        ? `already present (not a git repository) — ${entry.path ?? ''}`
        : `already present — ${entry.path ?? ''}`;
    case 'skip':
      return entry.skipReason === 'no_clone_url'
        ? `skipped (${entry.state}) — Motir cannot derive a clone URL for this provider`
        : `skipped (${entry.state}) — no repository behind this row yet`;
    case 'clone':
      return `clone → ${entry.path ?? ''}`;
  }
}

export interface RunRepoClonesOptions {
  run?: CommandRunner;
}

/**
 * Execute the `clone` entries of a plan, IN ORDER, and report every entry.
 *
 * ⚠️ ONE FAILURE DOES NOT ABORT THE REST. A run in which two of four
 * repositories fail is a real outcome with a real exit code, not an abort at the
 * first failure: the two that worked are on disk and the user can act on both
 * halves of the report. This is the same posture `git.ts` takes for a `gh`
 * failure at the end of `motir auto` — report, never throw, when the work
 * already done would otherwise be hidden behind a tooling gap.
 *
 * ⚠️ AND NOTHING IS ISSUED FOR A `present` ENTRY. Not a `remote get-url`, not a
 * `rev-parse` — the loop simply never reaches git for one, which is what makes
 * the never-touch invariant checkable over the runner's recorded invocations
 * rather than a promise about which commands are safe (§5).
 *
 * The clone runs in `rootDir` with the DESTINATION as an argument, rather than
 * in the destination (which does not exist yet). It is a FULL clone: no
 * `--depth`, no `--filter`, no `--single-branch` (§4).
 */
export function runRepoClones(
  rootDir: string,
  plan: readonly RepoClonePlanEntry[],
  opts: RunRepoClonesOptions = {},
): RepoCloneOutcome[] {
  const run = opts.run ?? execCommand;

  return plan.map((entry): RepoCloneOutcome => {
    if (entry.kind !== 'clone' || entry.cloneUrl === null || entry.path === null) {
      return {
        label: entry.label,
        status: entry.kind === 'present' ? 'present' : 'skipped',
        path: entry.path,
        detail: planDetail(entry),
        gitMessage: null,
      };
    }

    const res = run('git', ['clone', entry.cloneUrl, entry.path], rootDir);
    if (res.exitCode === 0) {
      return {
        label: entry.label,
        status: 'cloned',
        path: entry.path,
        detail: entry.archived
          ? `cloned → ${entry.path} (archived on the host — read-only)`
          : `cloned → ${entry.path}`,
        gitMessage: null,
      };
    }

    const message = res.stderr || res.stdout || `git exited ${res.exitCode}`;
    return {
      label: entry.label,
      status: 'failed',
      path: entry.path,
      detail: looksLikeAuthRefusal(message)
        ? cloneRefusalDetail(entry.cloneUrl)
        : `could not clone ${entry.cloneUrl}`,
      gitMessage: message,
    };
  });
}

/** Did any repository FAIL? The command's exit code reflects this and nothing
 *  else — an existing path is the invariant working, not a failure (§5). */
export function anyCloneFailed(outcomes: readonly RepoCloneOutcome[]): boolean {
  return outcomes.some((o) => o.status === 'failed');
}
