import { MotirClient } from '../client.js';
import { CliError, NotFoundError } from '../errors.js';
import { info, out } from '../output.js';
import type { CommandRunner } from '../git.js';
import {
  anyCloneFailed,
  planRepoClones,
  runRepoClones,
  type RepoCloneOutcome,
} from '../repoClone.js';
import { describeProject, resolveProject } from '../projectLink.js';
import { resolveServerUrl } from '../serverResolve.js';
import { resolveCredential } from '../config/userConfig.js';
import {
  findLink,
  overrideRepoNames,
  requireLink,
  resolveRepo,
  withRepoOverride,
  withoutRepoOverride,
  writeLink,
  type LinkConfig,
} from '../config/linkConfig.js';

// `motir link` — bind a WORKSPACE ROOT directory to a server + workspace +
// project. Repo checkouts resolve by CONVENTION (`<root>/<repoName>`); the
// optional `repos` map carries overrides only. The file holds NO secret (safe
// to commit); the token stays in the user config.

export interface LinkOptions {
  server?: string;
  workspace?: string;
  project?: string;
  /** Mark this very directory as a single repo's checkout → `{ <repo>: "." }`. */
  repo?: string;
  /**
   * `--no-clone`: bind only, exactly as this command behaved before MOTIR-3587.
   *
   * Commander gives a `--no-x` flag the property `x`, defaulting to `true`, so
   * this reads `clone !== false` at the one place it is consulted — an older
   * caller that constructs `LinkOptions` by hand and omits it still clones,
   * which is the default the ADR decided.
   *
   * ⚠️ NAMED FOR THE OPERATION IT SUPPRESSES. The card that proposed it called
   * it `--no-pull`, and `pull` is a git verb naming the ONE thing this command
   * promises never to do — it clones what is missing and never touches what
   * exists (ADR §1, §5).
   */
  clone?: boolean;
}

/** Get the token for `serverUrl` (env tier first) or fail with the login hint. */
function tokenFor(serverUrl: string): string {
  const cred = resolveCredential(serverUrl);
  if (!cred) {
    throw new CliError(`Not logged in to ${serverUrl}.`, {
      hint: 'Run `motir auth login`, or set MOTIR_TOKEN.',
    });
  }
  return cred.token;
}

/** What the access probe needs of a client — structural, so a test can drive
 *  the catch below with a stub that throws exactly one error. */
export type ProjectProbeClient = Pick<MotirClient, 'listReady'>;

/**
 * Confirm a project exists / is accessible under the token's workspace by
 * probing `list_ready` (an empty result is a valid empty project; a not-found
 * surfaces as the read's error).
 *
 * ⚠️ The catch NARROWS the reported failure to the ONE error that actually
 * means "inaccessible", and lets every other one through UNTOUCHED. It used to
 * rewrite every `CliError` — the whole class — into the accessibility sentence,
 * and that is destructive in exact proportion to how good the underlying
 * diagnosis was (MOTIR-2492). The instance that cost a session: a server behind
 * this CLI's contract floor raises `IncompatibleServerError`, which names the
 * server, the version it serves, the version required and the remedy — and
 * `motir link` replaced all of it with "check the project key, or your token's
 * workspace", none of which was the cause, on a token that could read the
 * project perfectly well. Every sibling error is likewise MORE specific than
 * the sentence that was overwriting it: `AuthError` says re-login, `PermissionError`
 * names the missing scope AND where to create a token with it, and a transport
 * failure names the host it could not reach.
 *
 * So only `NotFoundError` — a 404 carrying the v1 `{ code, error }` envelope,
 * i.e. the server saying this key resolves to nothing the token can see — earns
 * the rewrite, and even there the server's own sentence is chained as `cause`
 * rather than discarded. (A 404 with NO envelope is an unrouted path, which the
 * transport already reports as skew; it never reaches here as `NotFoundError`.)
 */
export async function assertProjectAccessible(
  client: ProjectProbeClient,
  projectKey: string,
): Promise<void> {
  try {
    await client.listReady({ projectKey, limit: 1 });
  } catch (err) {
    if (err instanceof NotFoundError) {
      throw new CliError(`Project "${projectKey}" is not accessible with this token.`, {
        hint: 'Check the project key, or your token’s workspace.',
        cause: err,
      });
    }
    throw err;
  }
}

/** What the materialize step needs of a client — structural, so a test drives
 *  it with a stub and no transport. */
export type RepoSetClient = Pick<MotirClient, 'listRepositories'>;

/**
 * BRING THE CODE DOWN — read the project's repository set and clone what is
 * missing into the linked folder (Story MOTIR-3584 · Subtask MOTIR-3587).
 *
 * Every behavioural branch is decided in
 * `docs/decisions/link-materializes-the-checkouts.md` and implemented in
 * `repoClone.ts`; this function is the I/O: one read, one plan, one run, one
 * line of report per repository.
 *
 * ⚠️ ONE LINE PER REPOSITORY OF THE SET, including the ones nothing was done to.
 * A four-row set that reports three lines is a set the reader cannot reason
 * about — `proposed` has to read as "not created yet" rather than as absence.
 *
 * Returns whether any repository FAILED, which is the only thing the exit code
 * reflects: an existing path is the never-touch invariant working, not a
 * failure (ADR §5).
 */
export async function materializeCheckouts(
  client: RepoSetClient,
  rootDir: string,
  config: LinkConfig,
  projectKey: string,
  // The git seam, injected so this whole function is drivable with no git
  // process and no network — `packages/cli/src/git.ts`'s standing rule, and what
  // lets a test assert the never-touch invariant over recorded invocations.
  opts: { run?: CommandRunner } = {},
): Promise<boolean> {
  const { repositories } = await client.listRepositories({ projectKey });
  if (repositories.length === 0) {
    // An honest empty answer, not a missing resource: every project that
    // predates the repository-set table is in this state.
    info('Repositories: none established for this project yet — nothing to clone.');
    return false;
  }

  const plan = planRepoClones(rootDir, config, repositories);
  const toClone = plan.filter((entry) => entry.kind === 'clone').length;
  if (toClone > 0) {
    info(`Cloning ${toClone} of ${repositories.length} repositor${toClone === 1 ? 'y' : 'ies'}…`);
  }

  const outcomes = runRepoClones(rootDir, plan, opts.run ? { run: opts.run } : {});
  reportCloneOutcomes(outcomes);
  return anyCloneFailed(outcomes);
}

/** Print one line per repository — plus git's own message, indented, under a
 *  failure. The message is never replaced by ours (MOTIR-2492's lesson, one
 *  command over): a rewrite that drops the underlying error leaves no way back
 *  to it. */
function reportCloneOutcomes(outcomes: readonly RepoCloneOutcome[]): void {
  out('Checkouts:');
  for (const outcome of outcomes) {
    out(`  ${outcome.label}: ${outcome.detail}`);
    if (outcome.gitMessage) out(`    git said: ${outcome.gitMessage}`);
  }
}

/** The refusal a failed pass ends on. The report is already printed, so this
 *  carries the exit code and the one-line summary, not the diagnosis. */
function cloneFailure(): CliError {
  return new CliError('Some repositories could not be cloned.', {
    hint: 'Fix what the lines above name, then run `motir link` again — nothing already present is re-cloned.',
  });
}

export async function linkCommand(opts: LinkOptions): Promise<void> {
  const cwd = process.cwd();
  const existing = findLink(cwd);

  // Bare re-run on an existing link with no binding flags → MATERIALIZE, then
  // SHOW it. This re-run is the idempotent fetch verb (ADR §1): it is what makes
  // "run it again and nothing is re-cloned" true, and returning early here — as
  // this path used to — is what would make it unreachable.
  const noBindingFlags = !opts.server && !opts.workspace && !opts.project && !opts.repo;
  if (existing && noBindingFlags) {
    let failed = false;
    if (opts.clone !== false) {
      const url = resolveServerUrl(existing.config.serverUrl);
      const client = new MotirClient({ serverUrl: url, token: tokenFor(url) });
      failed = await materializeCheckouts(
        client,
        existing.dir,
        existing.config,
        existing.config.project,
      );
    }
    showLink(existing.dir, existing.config);
    if (failed) throw cloneFailure();
    return;
  }

  const serverUrl = resolveServerUrl(opts.server ?? existing?.config.serverUrl);
  const token = tokenFor(serverUrl);

  const client = new MotirClient({ serverUrl, token });
  const who = await client.whoami();

  // Workspace: today the PAT is bound to one active workspace (lib/mcp/auth),
  // so default to it. An explicit flag (or a prior binding) wins as the label.
  const workspace = opts.workspace ?? existing?.config.workspace ?? who.workspace?.slug;
  if (!workspace) {
    throw new CliError('Could not determine the workspace.', {
      hint: 'Pass --workspace <slug>.',
    });
  }

  // A key the user ASSERTED (this run's flag, or the one already on the link)
  // is probed; a key they did NOT give is RESOLVED. The two are different
  // questions: the probe validates a claim, `list_projects` enumerates what
  // the token can actually reach — which is proof of access by construction,
  // so a resolved project needs no second round trip to justify itself.
  const asserted = opts.project ?? existing?.config.project;
  let project: string;
  let chosen: string | null = null;
  if (asserted) {
    await assertProjectAccessible(client, asserted);
    project = asserted;
  } else {
    const resolved = await resolveProject(client, workspace, serverUrl);
    project = resolved.project.key;
    chosen = describeProject(resolved, workspace);
  }

  // Build the config, preserving any existing repo overrides; `--repo` marks
  // this root as that single repo's checkout (the single-repo "." override).
  const config: LinkConfig = {
    serverUrl,
    workspace,
    project,
    ...(existing?.config.repos ? { repos: { ...existing.config.repos } } : {}),
  };
  const withRepo = opts.repo ? withRepoOverride(config, opts.repo, '.') : config;

  // Edit the found link in place, else create one at the cwd.
  const targetDir = existing?.dir ?? cwd;
  const path = writeLink(targetDir, withRepo);
  info(`Linked ${targetDir} → ${workspace}/${project} on ${serverUrl}`);
  // Only when nobody named the project: a link that chose FOR the user has to
  // say what it chose, and on what grounds.
  if (chosen) info(`Chose ${chosen}.`);
  info(`Wrote ${path}`);

  // ⚠️ AFTER the write, deliberately. `.motir.json` is the binding, and a clone
  // that fails must not cost the user the binding too — they can re-run
  // `motir link` and pick up exactly where this left off.
  const failed =
    opts.clone === false ? false : await materializeCheckouts(client, targetDir, withRepo, project);

  showLink(targetDir, withRepo);
  if (failed) throw cloneFailure();
}

export function linkAddCommand(repo: string, path: string): void {
  const found = requireLink();
  const next = withRepoOverride(found.config, repo, path);
  writeLink(found.dir, next);
  info(`Override set: ${repo} → ${path}`);
  showLink(found.dir, next);
}

export function linkRemoveCommand(repo: string): void {
  const found = requireLink();
  let next: LinkConfig;
  try {
    next = withoutRepoOverride(found.config, repo);
  } catch {
    throw new CliError(`No override for repo "${repo}".`);
  }
  writeLink(found.dir, next);
  info(`Override removed: ${repo}`);
  showLink(found.dir, next);
}

/** Print the binding + how each KNOWN repo (override entries) resolves. Repos
 * without an override resolve by the convention `<root>/<repoName>`. */
function showLink(rootDir: string, config: LinkConfig): void {
  out(`Root:      ${rootDir}`);
  out(`Server:    ${config.serverUrl}`);
  out(`Workspace: ${config.workspace}`);
  out(`Project:   ${config.project}`);
  const names = overrideRepoNames(config);
  if (names.length === 0) {
    out('Repos:     (none listed) — checkouts resolve by convention <root>/<repoName>');
    return;
  }
  out('Repos:');
  for (const name of names) {
    const r = resolveRepo(rootDir, config, name);
    const state = r.exists ? 'exists' : 'not yet';
    out(`  ${name} → ${r.path}  [${r.source}, ${state}]`);
  }
}
