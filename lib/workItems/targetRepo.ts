import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { repoCloneUrl } from '@/lib/repos/cloneUrl';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import {
  ArchivedTargetRepoError,
  UnknownTargetRepoError,
  type UnknownTargetRepoScope,
} from './errors';
import type { ServiceContext } from './serviceContext';

// Per-item REPO ATTRIBUTION (Story 7.9 · MOTIR-1804) — the rebuilt producer half
// of the cancelled 7.7.3 dispatch-payload contract, and the piece the CLI has
// been waiting on: `motir link add <repo> <path>` (7.9.1) already maps a repo
// NAME to a checkout path, but nothing told it which NAME an item belongs to.
//
// Three jobs, kept OUT of `workItemsService` so the (coverage-gated) service
// stays a thin caller and this policy is unit-testable without a work item:
//
//   1. NORMALIZE the authored value — trim, and accept the `owner/name` ref form
//      as an alias for the bare `name` the CLI keys on.
//   2. VALIDATE it against a repo DOMAIN. One repo registry, not two: a pin that
//      names a repo Motir isn't connected to is a typo, and a typed error is far
//      better than a dispatch that sends an agent to a directory that will never
//      exist.
//   3. RESOLVE the dispatch value — the explicit pin when there is one, else the
//      domain's SINGLE repo (the unambiguous default), else null.
//
// ⚠️ WHICH DOMAIN is no longer this module's decision (MOTIR-1783). A project now
// carries its own repository SET (`project_repository`, MOTIR-1780), and that set
// — not "the workspace's connected repos" — is what an item's pin means. The
// scope ladder (the project's set, else the workspace's connected repos for a
// project that predates the set) lives in `lib/workItems/dispatchRepo.ts`; this
// module owns the workspace-scoped domain + the SCOPE-FREE policy both consume.
//
// Why resolution happens at DISPATCH and not at CREATE: the connected set moves
// (repos get connected and disconnected). Baking today's default into every row
// would freeze a GUESS as if it were a decision, and the two would be
// indistinguishable afterwards. Keeping the column to explicit pins only means
// the payload always reflects current reality, and `null` on the wire honestly
// means "Motir does not know" — which is exactly the signal the CLI needs to
// fall back to its workspace-root rule (never a guess).
//
// Composition mirrors `lib/ai/codeContext.ts`: this opens its OWN workspace
// context (the `github_repo` RLS policies are workspace-keyed and the work-item
// service does not run inside one), so every caller MUST invoke it OUTSIDE its
// write transaction — never nested inside a `db.$transaction`.

/** The bare repo NAME the CLI keys checkouts on (`motir-core`), plus the
 *  `owner/name` ref it came from — enough to explain an ambiguity in an error —
 *  and the coordinates an agent that has NO checkout yet needs to make one. */
export interface ConnectedRepoName {
  /** The bare repo name — the value stored in `work_item.targetRepo`. */
  name: string;
  /** `owner/name`, the display form used in error messages. */
  repoRef: string;
  /**
   * The HTTPS clone URL (MOTIR-1783), or `null` when Motir cannot derive one —
   * an unknown provider, or a name that exists only as a PLAN (a proposed set
   * row whose repository has not been created yet). Derived from the
   * coordinates, never stored (see `lib/repos/cloneUrl.ts`).
   */
  cloneUrl: string | null;
  /**
   * The repository's default branch, or `null` for a name Motir knows only as a
   * plan. The agent branches from this; `null` means "Motir does not know", not
   * "main" — assuming a default is the same guess this module refuses to make
   * about which repo an ambiguous item belongs to.
   */
  defaultBranch: string | null;
  /**
   * Whether the repository is ARCHIVED on the host (MOTIR-1959) — read-only, so
   * it accepts no branch and no pull request from anyone.
   *
   * ⚠️ An archived repo stays IN the domain, flagged, rather than being filtered
   * out of it. Filtering would be the easy change and the wrong one: a pin always
   * wins over the domain (see {@link resolveDispatchRepo}), so a dropped entry
   * would resolve to the pinned name with null coordinates — a silent degradation
   * indistinguishable from "Motir does not know where this lives". Keeping the
   * entry is what lets the resolution REFUSE and say why.
   *
   * `false` for a name Motir knows only as a PLAN: an unrealized row has no
   * repository to be archived, and its non-dispatchability is already the whole
   * meaning of it not being in the dispatch domain.
   */
  archived: boolean;
}

/**
 * The workspace's connected repos, as the names a `targetRepo` may reference.
 * De-duplicated by NAME (two owners can expose the same repo name; the CLI
 * checks both out at `<root>/<name>`, so they are one checkout identity as far
 * as dispatch is concerned — first by the repository's stable owner/name order
 * wins). Empty when the workspace has no connection, which makes every non-null
 * pin invalid — the honest outcome: attribution is meaningless with no repos.
 */
export async function listConnectedRepoNames(ctx: ServiceContext): Promise<ConnectedRepoName[]> {
  const repos = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    (tx) => githubRepoRepository.listByWorkspace(ctx.workspaceId, tx),
  );
  const byName = new Map<string, ConnectedRepoName>();
  for (const repo of repos) {
    if (!byName.has(repo.name)) {
      byName.set(repo.name, {
        name: repo.name,
        repoRef: `${repo.owner}/${repo.name}`,
        cloneUrl: repoCloneUrl(repo),
        defaultBranch: repo.defaultBranch,
        archived: repo.archived,
      });
    }
  }
  return [...byName.values()];
}

/**
 * Normalize an authored `targetRepo` to the bare repo NAME the column stores.
 *
 * Accepts either the bare name (`motir-core`) or the `owner/name` ref form
 * (`moooon/motir-core`) — the latter is what `resolveCodeContext` and the GitHub
 * surfaces display, so an agent that copies a repo from there gets the same
 * result as one that types the short name. A blank / whitespace-only string
 * normalizes to `null` (an explicit clear), so a caller never has to distinguish
 * "" from null.
 */
export function normalizeTargetRepo(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const slash = trimmed.lastIndexOf('/');
  const name = slash === -1 ? trimmed : trimmed.slice(slash + 1).trim();
  return name.length === 0 ? null : name;
}

/**
 * Normalize + VALIDATE an authored `targetRepo` against a repo DOMAIN, returning
 * the value to store (`null` clears the pin). PURE — the caller supplies the
 * domain, which is what lets the project-scoped ladder
 * (`lib/workItems/dispatchRepo.ts`) reuse this policy verbatim instead of
 * re-deriving it.
 *
 * Matching is case-insensitive — git-host repo names are, and a pin that differs
 * only in case names the same checkout. The STORED value is the domain repo's
 * own casing, so the column and `.motir.json` can never disagree on the
 * directory name. An unknown name throws `UnknownTargetRepoError` (422 at the
 * route layer, a self-correctable tool error over MCP) naming the known set.
 */
export function matchAuthoredTargetRepo(
  value: string | null | undefined,
  domain: ConnectedRepoName[],
  scope: UnknownTargetRepoScope = 'workspace',
): string | null {
  const name = normalizeTargetRepo(value);
  if (name === null) return null;
  const match = domain.find((r) => r.name.toLowerCase() === name.toLowerCase());
  if (!match) {
    throw new UnknownTargetRepoError(
      name,
      domain.map((r) => r.repoRef),
      scope,
    );
  }
  return match.name;
}

/**
 * The resolved dispatch REPO: which repo to run an item in, and — new in
 * MOTIR-1783 — how to obtain it. `null` when Motir cannot say which repo, which
 * is a real answer the CLI acts on (it falls back to its link-root rule).
 *
 * `cloneUrl` / `defaultBranch` are independently nullable: a pin can name a repo
 * whose coordinates Motir does not know (a set row that is still a PLAN, or a
 * pin that outlived its connection), and echoing the recorded NAME while
 * admitting the rest is unknown beats dropping the routing decision entirely.
 */
export interface ResolvedDispatchRepo {
  /** The bare repo NAME the CLI keys `<root>/<name>` on. */
  name: string;
  /** The HTTPS clone URL, or `null` when Motir does not know it. */
  cloneUrl: string | null;
  /** The repo's default branch, or `null` when Motir does not know it. */
  defaultBranch: string | null;
}

/**
 * The DISPATCH repo: the explicit pin when the item carries one, else the
 * domain's single repo when that is unambiguous, else `null`.
 *
 * "Exactly one repo" is the only safe default — with two or more there is no
 * non-arbitrary choice, and a wrong repo sends the agent's cwd into the wrong
 * checkout, which is worse than no answer at all (the CLI's documented fallback
 * for `null` is the link root, where a human notices immediately).
 *
 * A PIN always wins, even when the domain does not contain it: the pin is a
 * recorded decision, and the domain can legitimately lag it (a row whose repo is
 * not created yet, a repo disconnected after the pin was authored). Such a pin
 * resolves with NULL coordinates — the name Motir was told, and an honest "I
 * cannot tell you where it lives".
 *
 * ⚠️ **THROWS {@link ArchivedTargetRepoError} when the repo it resolved to is
 * ARCHIVED** (MOTIR-1959) — read-only on the host, so the dispatch it is about to
 * authorize cannot open a branch or a pull request no matter what the agent does.
 *
 * A THROW rather than a `null`, and this is the whole design: `null` is a real
 * answer here ("Motir cannot say which repo"), and the CLI acts on it by falling
 * back to its link-root rule — which for an archived target would send an agent
 * to work in a checkout it can never push. The failure has to arrive as a stated
 * reason naming the repository, BEFORE any branch or PR attempt, which is the
 * only form a person can act on (the fix is on the host, and nothing Motir does
 * next can substitute for it).
 *
 * It applies to the single-repo DEFAULT as much as to an explicit pin. The two
 * differ in how the repo was chosen and not at all in what is wrong with it, and
 * a project whose only repository is archived is exactly the case where a silent
 * `null` would read as "no repos configured".
 */
export function resolveDispatchRepo(
  pinned: string | null,
  domain: ConnectedRepoName[],
): ResolvedDispatchRepo | null {
  if (pinned !== null) {
    const match = domain.find((r) => r.name.toLowerCase() === pinned.toLowerCase());
    if (match?.archived) throw new ArchivedTargetRepoError(match.name, match.repoRef);
    return {
      name: pinned,
      cloneUrl: match?.cloneUrl ?? null,
      defaultBranch: match?.defaultBranch ?? null,
    };
  }
  const only = domain.length === 1 ? domain[0]! : null;
  if (!only) return null;
  if (only.archived) throw new ArchivedTargetRepoError(only.name, only.repoRef);
  return { name: only.name, cloneUrl: only.cloneUrl, defaultBranch: only.defaultBranch };
}

/**
 * The dispatch repo NAME alone — {@link resolveDispatchRepo} projected to the
 * field `ReadyItemDispatchDto.targetRepo` has carried since MOTIR-1804. Kept as
 * its own export so the shipped name-only callers (and their tests) read
 * unchanged.
 */
export function resolveDispatchTargetRepo(
  pinned: string | null,
  domain: ConnectedRepoName[],
): string | null {
  return resolveDispatchRepo(pinned, domain)?.name ?? null;
}
