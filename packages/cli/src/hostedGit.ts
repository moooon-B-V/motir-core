import { spawnSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { MotirClient, type RunGitCredentials } from './client.js';
import { CliError } from './errors.js';
import { setActiveHostedRun, type HostedAttribution } from './hostedAttribution.js';

// A HOSTED RUN'S GITHUB ACCESS (Story MOTIR-683 · MOTIR-6559).
//
// `docs/decisions/hosted-run-runs-the-cli-as-the-app.md` §5–§7: a hosted run
// writes to GitHub as Motir's App — `motir-studio` or Motir Integration — with
// installation tokens the run fetches from its own git-credential route
// (MOTIR-6538), one per repository of the run. No git token is ever put in an
// environment: git and `gh` reach GitHub only through THIS module.
//
// ── What `prepareHostedRun` sets up, once, before the first checkout ───────
//   <state>/run.json          the route's address and the RUN credential (0600)
//   <state>/credentials.json  the tokens the route last handed out (0600)
//   <state>/gitconfig         the run's global git config (`GIT_CONFIG_GLOBAL`):
//                             the credential helper, and per repository an
//                             `includeIf` naming the App's bot as its author
//   <state>/bin/gh            a shim that gives the real `gh` the repository's
//                             token for that ONE invocation (`GH_TOKEN`)
//
// ⚠️ THE IDENTITY IS KEYED ON THE REMOTE, not written into each checkout. An
// `includeIf "hasconfig:remote.*.url:…"` (git ≥ 2.36) applies to every checkout
// of that repository whoever clones it — the CLI's materialize, a scope's
// `repos.ensure`, or the agent itself — so no clone path can miss it, and
// `user.useConfigOnly` makes a checkout the run does not know refuse to commit
// rather than guess an identity from the host.
//
// ⚠️ WHERE THE LOCK IS (decision §7). The agent commits and pushes, as in a
// local run, so it can reach git — and so the RUN credential sits in a 0600 file
// the same user can read. That is not a privilege boundary and does not pretend
// to be one: the bound is each token's own scope (the run's repositories,
// `contents` + `pull_requests`, an hour, revoked at the run's end). What this
// module does guarantee is that no credential is in the agent's ENVIRONMENT.

/** Where a helper process finds the run's state — set by `prepareHostedRun`. */
export const HOSTED_STATE_ENV = 'MOTIR_HOSTED_STATE';

/** A cached token is refreshed this long before GitHub expires it (card: 5 min). */
export const CREDENTIAL_REFRESH_MARGIN_MS = 5 * 60_000;

/** The GitHub host the run's repositories live on. */
const GITHUB_HOST = 'github.com';

/** The user name GitHub expects beside an installation token. */
const TOKEN_USERNAME = 'x-access-token';

/** How the run's own route is reached — written once, read by every helper. */
export interface HostedRunAccess {
  apiUrl: string;
  runId: string;
  token: string;
}

type CredentialEntry = RunGitCredentials['credentials'][number];

interface CredentialCache {
  dispatchedBy: string | null;
  entries: Record<string, CredentialEntry>;
}

/** Fetch a run's credentials. The seam the tests replace; production asks the route. */
export type IssueCredentials = (access: HostedRunAccess) => Promise<RunGitCredentials>;

const issueFromRoute: IssueCredentials = (access) =>
  new MotirClient({ serverUrl: access.apiUrl, token: access.token }).issueRunGitCredentials(
    access.runId,
  );

// ── Repository names ───────────────────────────────────────────────────────

/**
 * `owner/name` from anything git or `gh` hands us — a path (`owner/name.git`),
 * an HTTPS or SSH URL, or a bare `owner/name`. Null when it names no GitHub
 * repository, which the callers treat as "not ours to answer".
 */
export function githubRepository(value: string): string | null {
  let rest = value.trim();
  const url = /^(?:https?:\/\/|ssh:\/\/git@)([^/]+)\/(.*)$/i.exec(rest);
  const scp = /^git@([^:]+):(.*)$/i.exec(rest);
  if (url) {
    if (url[1]!.toLowerCase() !== GITHUB_HOST) return null;
    rest = url[2]!;
  } else if (scp) {
    if (scp[1]!.toLowerCase() !== GITHUB_HOST) return null;
    rest = scp[2]!;
  }
  rest = rest.replace(/\/+$/, '').replace(/\.git$/i, '');
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(rest) ? rest : null;
}

/** The cache key for a repository — GitHub's names are case-insensitive. */
function repoKey(repository: string): string {
  return repository.toLowerCase();
}

// ── State files ────────────────────────────────────────────────────────────

const RUN_FILE = 'run.json';
const CACHE_FILE = 'credentials.json';
const GITCONFIG_FILE = 'gitconfig';

function writePrivate(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
  // `mode` applies only on create; an existing file keeps its own.
  chmodSync(path, 0o600);
}

export function readRunAccess(stateDir: string): HostedRunAccess {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, RUN_FILE), 'utf8')) as HostedRunAccess;
    if (parsed.apiUrl && parsed.runId && parsed.token) return parsed;
  } catch {
    /* fall through to the refusal below */
  }
  throw new CliError(`No hosted run is set up in ${stateDir}.`, {
    hint: 'The git credential helper serves only a hosted run `motir run` prepared.',
  });
}

function readCache(stateDir: string): CredentialCache {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, CACHE_FILE), 'utf8')) as CredentialCache;
    if (parsed && typeof parsed.entries === 'object' && parsed.entries !== null) return parsed;
  } catch {
    /* an absent or torn cache is an empty one — the route refills it */
  }
  return { dispatchedBy: null, entries: {} };
}

function writeCache(stateDir: string, issued: RunGitCredentials): CredentialCache {
  const cache: CredentialCache = { dispatchedBy: issued.dispatchedBy, entries: {} };
  for (const entry of issued.credentials) cache.entries[repoKey(entry.repository)] = entry;
  writePrivate(join(stateDir, CACHE_FILE), `${JSON.stringify(cache, null, 2)}\n`);
  return cache;
}

function fresh(entry: CredentialEntry | undefined, now: Date): entry is CredentialEntry {
  if (!entry) return false;
  const expires = Date.parse(entry.expiresAt);
  return Number.isFinite(expires) && expires - now.getTime() > CREDENTIAL_REFRESH_MARGIN_MS;
}

/**
 * The token for ONE repository of the run: the cached one while it has more
 * than five minutes left, otherwise a fresh set from the route.
 *
 * ⚠️ A REFRESH REPLACES THE WHOLE CACHE. The route mints for every repository
 * of the run at once (repositories under one installation share a token), so a
 * refresh for one is a refresh for all — and keeping the others' older tokens
 * beside the new ones would only keep tokens the end path is about to revoke.
 */
export async function credentialFor(
  stateDir: string,
  repository: string,
  deps: { now?: () => Date; issue?: IssueCredentials } = {},
): Promise<CredentialEntry> {
  const now = (deps.now ?? (() => new Date()))();
  const key = repoKey(repository);
  const cached = readCache(stateDir).entries[key];
  if (fresh(cached, now)) return cached;
  const issued = await (deps.issue ?? issueFromRoute)(readRunAccess(stateDir));
  const entry = writeCache(stateDir, issued).entries[key];
  if (!entry) {
    throw new CliError(`${repository} is not one of this hosted run's repositories.`, {
      hint: 'A hosted run holds tokens for its own repositories only.',
    });
  }
  return entry;
}

/** Drop a repository's cached token — git's `erase`, after GitHub refused it. */
export function forgetCredential(stateDir: string, repository: string): void {
  const cache = readCache(stateDir);
  if (!(repoKey(repository) in cache.entries)) return;
  delete cache.entries[repoKey(repository)];
  writePrivate(join(stateDir, CACHE_FILE), `${JSON.stringify(cache, null, 2)}\n`);
}

// ── The run's git configuration ────────────────────────────────────────────

/** Quote one word for `sh -c` — git runs a `!` helper through the shell. */
function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** Quote a value for a git config file. */
function gitValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The command line that re-enters THIS CLI: `node <motir>`, by default. */
export function defaultCliInvocation(): string[] {
  return [process.execPath, ...process.execArgv, resolve(process.argv[1] ?? 'motir')];
}

/**
 * Write the run's global git config: the credential helper for GitHub, and per
 * repository the App's bot as author (see the header for why it is keyed on
 * the remote).
 */
export function writeHostedGitConfig(
  stateDir: string,
  issued: RunGitCredentials,
  cli: readonly string[],
): string {
  const identityDir = join(stateDir, 'identity');
  mkdirSync(identityDir, { recursive: true, mode: 0o700 });
  const helper = `!${[...cli, 'git-credential', '--state', stateDir].map(shellQuote).join(' ')}`;
  const lines = [
    '# Written by `motir` for a hosted run (MOTIR-6559). Git reaches GitHub only',
    '# through the helper below, and commits as the App that writes each repository.',
    '[user]',
    '\tuseConfigOnly = true',
    `[credential "https://${GITHUB_HOST}"]`,
    // The empty value RESETS the helper list, so no system helper answers first.
    '\thelper =',
    `\thelper = ${gitValue(helper)}`,
    '\tuseHttpPath = true',
  ];
  issued.credentials.forEach((entry, i) => {
    const identity = join(identityDir, `${i}.gitconfig`);
    writeFileSync(
      identity,
      [
        '[user]',
        `\tname = ${gitValue(entry.authorName)}`,
        `\temail = ${gitValue(entry.authorEmail)}`,
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    for (const suffix of ['', '.git']) {
      lines.push(
        `[includeIf "hasconfig:remote.*.url:https://${GITHUB_HOST}/${entry.repository}${suffix}"]`,
        `\tpath = ${gitValue(identity)}`,
      );
    }
  });
  const path = join(stateDir, GITCONFIG_FILE);
  writePrivate(path, `${lines.join('\n')}\n`);
  return path;
}

/** Write the `gh` shim — every `gh` on the run's PATH goes through `motir hosted-gh`. */
function writeGhShim(stateDir: string, cli: readonly string[]): string {
  const bin = join(stateDir, 'bin');
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  const call = [...cli, 'hosted-gh', '--state', stateDir, '--'].map(shellQuote).join(' ');
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec ${call} "$@"\n`, { mode: 0o755 });
  chmodSync(join(bin, 'gh'), 0o755);
  return bin;
}

// ── Preparing a hosted run ─────────────────────────────────────────────────

export interface PrepareHostedRunInput {
  serverUrl: string;
  token: string;
  runId: string;
  targetKey: string;
  client: Pick<MotirClient, 'issueRunGitCredentials'>;
  /** The environment the CLI and its children run with. Mutated. */
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  /** The command that re-enters this CLI (tests point it at the source). */
  cli?: readonly string[];
  /**
   * AGENT MODE (MOTIR-7024): the run is in one of the developer's own agents,
   * in a home they keep. `gh`'s own state is redirected into the state
   * directory, and the Motir tokens leave this process's environment — the
   * run's token is read from `run.json` by whoever needs it.
   */
  agentMode?: boolean;
}

/**
 * Set up the run's GitHub access BEFORE anything is cloned: fetch its
 * credentials once (which is also where `dispatchedBy` comes from), write the
 * state, the git config and the `gh` shim, and point this process's
 * environment — which every checkout, every `gh` and the agent inherit — at
 * them.
 */
export async function prepareHostedRun(input: PrepareHostedRunInput): Promise<HostedAttribution> {
  const env = input.env ?? process.env;
  const stateDir =
    input.stateDir || env[HOSTED_STATE_ENV]?.trim() || mkdtempSync(join(tmpdir(), 'motir-hosted-'));
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const cli = input.cli ?? defaultCliInvocation();

  const access: HostedRunAccess = {
    apiUrl: input.serverUrl,
    runId: input.runId,
    token: input.token,
  };
  writePrivate(join(stateDir, RUN_FILE), `${JSON.stringify(access)}\n`);
  const issued = await input.client.issueRunGitCredentials(input.runId);
  writeCache(stateDir, issued);

  env['GIT_CONFIG_GLOBAL'] = writeHostedGitConfig(stateDir, issued, cli);
  env['GIT_TERMINAL_PROMPT'] = '0';
  env['PATH'] = [writeGhShim(stateDir, cli), env['PATH'] ?? ''].filter(Boolean).join(delimiter);
  env[HOSTED_STATE_ENV] = stateDir;
  if (input.agentMode) {
    // ⚠️ THE DEVELOPER'S `~/.config/gh` IS NEVER WRITTEN (agent-instance-run.md
    // §2): the real `gh` the shim runs keeps its config and state in the run's
    // directory, and never checks for an update.
    env['GH_CONFIG_DIR'] = join(stateDir, 'gh');
    env['GH_NO_UPDATE_NOTIFIER'] = '1';
    for (const name of AGENT_MODE_UNSET_ENV) delete env[name];
  }

  return setActiveHostedRun({
    runId: input.runId,
    serverUrl: input.serverUrl,
    targetKey: input.targetKey,
    dispatchedBy: issued.dispatchedBy,
    stateDir,
  });
}

/** The token names an agent-mode run removes from its own environment (MOTIR-7024). */
export const AGENT_MODE_UNSET_ENV = ['MOTIR_TOKEN', 'MOTIR_RUN_TOKEN'] as const;

// ── AGENT MODE: nothing of the run outlives it (MOTIR-7024) ─────────────────

export interface AgentRunScratch {
  /** The run's state directory: `run.json`, the helper's cache, `gitconfig`, `bin/gh`. */
  stateDir: string;
  /** The run's checkouts — `$HOME/.motir/runs/<runId>` unless the launcher said otherwise. */
  workspace: string;
}

/**
 * Take charge of an agent-mode run's two directories: create the workspace,
 * and return the one function that removes BOTH — plus any empty parent the
 * workspace needed that did not exist before — on every way the process ends.
 *
 * `agent-instance-run.md` §2: the run lives in a home the developer keeps for
 * weeks, so what it made there must be gone when it ends. The returned remover
 * is idempotent and runs from the caller's `finally` (success and failure);
 * the `exit` listener registered here covers the interrupt handler, which ends
 * the process with `process.exit` and so never reaches a `finally`. The
 * terminal server removes the same two directories after the session exits,
 * which is harmless after this.
 */
export function claimAgentRunScratch(
  scratch: AgentRunScratch,
  deps: {
    onExit?: (listener: () => void) => () => void;
  } = {},
): () => void {
  const created: string[] = [];
  for (let dir = resolve(scratch.workspace); !existsSync(dir); dir = dirname(dir)) {
    created.push(dir);
    if (dirname(dir) === dir) break;
  }
  mkdirSync(scratch.workspace, { recursive: true, mode: 0o700 });
  const onExit =
    deps.onExit ??
    ((listener: () => void) => {
      process.on('exit', listener);
      return () => process.off('exit', listener);
    });
  let detach: () => void = () => {};
  // Every call removes — no "already done" latch — so a write that lands after
  // an early removal (the interrupt's) is still taken by the `finally`'s.
  const remove = (): void => {
    detach();
    rmSync(scratch.workspace, { recursive: true, force: true });
    rmSync(scratch.stateDir, { recursive: true, force: true });
    // Deepest first; a parent that is no longer empty is somebody else's now.
    for (const dir of created) {
      try {
        rmdirSync(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') break;
      }
    }
  };
  detach = onExit(remove);
  return remove;
}

// ── A REVIEW run is READ-ONLY (MOTIR-6824) ─────────────────────────────────

/** The URL scheme every push is rewritten to in a review run — no transport has it. */
export const REVIEW_PUSH_REFUSED_SCHEME = 'motir-review-refuses-push';

/** What the refusing `gh` says — a review posts nothing to GitHub. */
export const REVIEW_GH_REFUSAL =
  'motir: `gh` is disabled in a hosted REVIEW run — a review posts nothing to GitHub ' +
  '(hosted-agent-run.md §8.3). Write your verdict to the file your prompt names.';

/**
 * LOCK a prepared hosted run READ-ONLY, for `motir review` (`hosted-agent-run.md` §8.3).
 * Called after {@link prepareHostedRun} and before any checkout or agent:
 *
 *   - every push to GitHub is rewritten (`url.<x>.pushInsteadOf`) to a scheme no git
 *     transport speaks, so `git push` fails before it connects — whoever runs it, from
 *     whichever checkout. A push rewrite outranks the fetch-side `insteadOf`, so no
 *     redirect of the fetch URL reopens it;
 *   - a `pre-push` hook that refuses, through `core.hooksPath`, as a second wall;
 *   - the run's `gh` shim is REPLACED by one that refuses every call, so nothing the
 *     agent does can open, comment on or review a pull request.
 *
 * ⚠️ WHERE THE LOCK IS. This is the launcher's no-push rule — on a user's repository
 * the §4 user token cannot be narrowed by permission, so this IS the guard there; on a
 * Motir-created repository the server also mints the token `contents: read`. It
 * guards against an agent that tries; an agent that rewrites the global git config
 * could undo it, which is why the token's own scope stays the bound.
 */
export function lockHostedRunReadOnly(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const gitconfig = join(stateDir, GITCONFIG_FILE);
  const hooks = join(stateDir, 'review-hooks');
  mkdirSync(hooks, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(hooks, 'pre-push'),
    `#!/bin/sh\necho "motir: pushing is disabled in a hosted REVIEW run (hosted-agent-run.md §8.3)." >&2\nexit 1\n`,
    { mode: 0o755 },
  );
  chmodSync(join(hooks, 'pre-push'), 0o755);
  const current = readFileSync(gitconfig, 'utf8');
  const lock = [
    '# A hosted REVIEW run pushes nothing (MOTIR-6824, hosted-agent-run.md §8.3).',
    `[url "${REVIEW_PUSH_REFUSED_SCHEME}://github.com/"]`,
    `\tpushInsteadOf = https://${GITHUB_HOST}/`,
    `\tpushInsteadOf = git@${GITHUB_HOST}:`,
    `\tpushInsteadOf = ssh://git@${GITHUB_HOST}/`,
    '[core]',
    `\thooksPath = ${gitValue(hooks)}`,
  ];
  writePrivate(gitconfig, `${current.replace(/\n*$/, '\n')}${lock.join('\n')}\n`);
  env['GIT_CONFIG_GLOBAL'] = gitconfig;

  const bin = join(stateDir, 'bin');
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho ${shellQuote(REVIEW_GH_REFUSAL)} >&2\nexit 1\n`, {
    mode: 0o755,
  });
  chmodSync(join(bin, 'gh'), 0o755);
  if (!(env['PATH'] ?? '').split(delimiter).includes(bin)) {
    env['PATH'] = [bin, env['PATH'] ?? ''].filter(Boolean).join(delimiter);
  }
}

// ── A REPAIR run pushes to its pull requests' OWN branches only (MOTIR-6929) ──

/** What the refusing `gh` says in a repair run — it opens and posts nothing. */
export const REPAIR_GH_REFUSAL =
  'motir: `gh` is disabled in a hosted REPAIR run — a repair opens no pull request and ' +
  'posts nothing to GitHub (hosted-agent-run.md §8.6). Commit and push to the branch you are on.';

/** The client hooks a repair run's hooks directory answers — each hands on to the checkout's own. */
const CLIENT_HOOKS = [
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-rebase',
  'post-checkout',
  'post-merge',
  'pre-push',
  'post-rewrite',
] as const;

/**
 * The hook every name above runs: `pre-push` first checks every ref the push would
 * update against the allow-list, then — for every hook — the checkout's OWN hook of
 * that name runs (its local `core.hooksPath`, else `.git/hooks`), so a repository's
 * husky hooks behave exactly as they would without the guard.
 */
function repairHookScript(allowedFile: string): string {
  return `#!/bin/sh
# Written by \`motir fix\` for a hosted REPAIR run (MOTIR-6929, hosted-agent-run.md §8.6).
name=$(basename "$0")
input=""
if [ "$name" = "pre-push" ]; then
  input=$(cat)
  remote_url=$(git config --get "remote.$1.url" 2>/dev/null || true)
  [ -n "$remote_url" ] || remote_url="$1"
  repo=$(printf '%s' "$remote_url" | sed -e 's#^https://github\\.com/##' -e 's#^ssh://git@github\\.com/##' -e 's#^git@github\\.com:##' -e 's#/$##' -e 's#\\.git$##')
  # A sha of zeros (40 or 64) is "no commit": a delete on the left, a new ref on the right.
  nothing() { case "$1" in *[!0]*) return 1 ;; *) return 0 ;; esac; }
  refused=0
  while read -r local_ref local_sha remote_ref remote_sha; do
    [ -n "$remote_ref" ] || continue
    if ! grep -qxF "$repo $remote_ref" ${shellQuote(allowedFile)}; then
      echo "motir: a hosted repair pushes only to its pull requests' own branches — refusing $remote_ref on $repo." >&2
      refused=1
    elif nothing "$local_sha"; then
      echo "motir: a hosted repair never deletes a branch — refusing to delete $remote_ref on $repo." >&2
      refused=1
    elif ! nothing "$remote_sha" && ! git merge-base --is-ancestor "$remote_sha" "$local_sha" 2>/dev/null; then
      echo "motir: a hosted repair never rewrites a pull request's history — refusing a non-fast-forward push to $remote_ref on $repo." >&2
      refused=1
    fi
  done <<EOF_MOTIR_REFS
$input
EOF_MOTIR_REFS
  [ "$refused" = 0 ] || exit 1
fi
own=$(git config --local --get core.hooksPath 2>/dev/null || true)
if [ -n "$own" ]; then
  case "$own" in /*) ;; *) own="$(git rev-parse --show-toplevel 2>/dev/null)/$own" ;; esac
  hook="$own/$name"
else
  hook="$(git rev-parse --git-common-dir 2>/dev/null)/hooks/$name"
fi
if [ -x "$hook" ]; then
  if [ "$name" = "pre-push" ]; then
    printf '%s\\n' "$input" | "$hook" "$@"
    exit $?
  fi
  exec "$hook" "$@"
fi
exit 0
`;
}

/**
 * LOCK a prepared hosted run to its pull requests' OWN branches, for a hosted `motir fix`
 * (`hosted-agent-run.md` §8.6). Called after {@link prepareHostedRun} and before any
 * agent:
 *
 *   - every hook git runs goes through the run's own hooks directory, set as
 *     `core.hooksPath` in the COMMAND scope (`GIT_CONFIG_COUNT`), which outranks a
 *     checkout's own `core.hooksPath` — so a `pnpm install` that re-installs husky
 *     cannot move it aside. Its `pre-push` refuses any ref that is not
 *     `refs/heads/<branch>` of an allowed pull request in ITS repository, a delete, and
 *     a non-fast-forward; every hook then runs the checkout's own hook of that name;
 *   - the run's `gh` shim is REPLACED by one that refuses every call — a repair opens
 *     no pull request and posts nothing to GitHub.
 *
 * ⚠️ WHERE THE LOCK IS — as for the review's: it guards against an agent that pushes
 * where it should not by mistake. An agent that runs `git push --no-verify` or rewrites
 * the environment could pass it, which is why the §4 credential's own scope — the run's
 * repositories, an hour, revoked at the run's end — stays the bound.
 */
export function lockHostedRunToBranches(
  stateDir: string,
  allowed: ReadonlyArray<{ repository: string; branch: string }>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const hooks = join(stateDir, 'repair-hooks');
  mkdirSync(hooks, { recursive: true, mode: 0o700 });
  const allowedFile = join(stateDir, 'repair-push-allowed');
  writePrivate(
    allowedFile,
    `${[...new Set(allowed.map((a) => `${a.repository} refs/heads/${a.branch}`))].join('\n')}\n`,
  );
  const script = repairHookScript(allowedFile);
  for (const name of CLIENT_HOOKS) {
    writeFileSync(join(hooks, name), script, { mode: 0o755 });
    chmodSync(join(hooks, name), 0o755);
  }
  // The COMMAND scope — the run's own, and the only entry: the agent's allow-listed
  // environment carries exactly index 0 (`HOSTED_AGENT_ENV_KEYS`).
  if (env['GIT_CONFIG_COUNT']?.trim()) {
    throw new CliError(
      'This hosted run already carries command-scope git config; refusing to repair.',
      {
        hint: 'A hosted container is booted without GIT_CONFIG_COUNT — the repair lock owns it.',
      },
    );
  }
  env['GIT_CONFIG_COUNT'] = '1';
  env['GIT_CONFIG_KEY_0'] = 'core.hooksPath';
  env['GIT_CONFIG_VALUE_0'] = hooks;

  const bin = join(stateDir, 'bin');
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho ${shellQuote(REPAIR_GH_REFUSAL)} >&2\nexit 1\n`, {
    mode: 0o755,
  });
  chmodSync(join(bin, 'gh'), 0o755);
  if (!(env['PATH'] ?? '').split(delimiter).includes(bin)) {
    env['PATH'] = [bin, env['PATH'] ?? ''].filter(Boolean).join(delimiter);
  }
}

// ── `motir git-credential` — git's credential-helper protocol ───────────────

function stateArg(argv: string[]): { stateDir: string; rest: string[] } {
  const at = argv.indexOf('--state');
  const fromFlag = at >= 0 ? argv[at + 1] : undefined;
  const stateDir = fromFlag ?? process.env[HOSTED_STATE_ENV];
  if (!stateDir) {
    throw new CliError('The hosted git plumbing needs --state <dir>.');
  }
  const rest = at >= 0 ? [...argv.slice(0, at), ...argv.slice(at + 2)] : argv;
  return { stateDir, rest };
}

/** Parse git's `key=value` request lines. */
function parseCredentialRequest(input: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const line of input.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) attrs.set(line.slice(0, eq), line.slice(eq + 1).replace(/\r$/, ''));
  }
  return attrs;
}

/**
 * `motir git-credential [--state <dir>] get|store|erase`, speaking git's
 * credential-helper protocol on stdin/stdout.
 *
 * `get` answers ONLY an HTTPS request for a repository on GitHub, and says
 * nothing (exit 0, empty output) about anything else, which is the protocol's
 * way of letting git ask the next helper. `erase` — git's signal that GitHub
 * refused what it was given — drops the cached token so the next `get` fetches
 * a fresh one. `store` is a no-op: the route is the only source of a token.
 */
export async function gitCredentialCommand(
  argv: string[],
  io: { stdin: string; write: (s: string) => void },
  deps: { now?: () => Date; issue?: IssueCredentials } = {},
): Promise<number> {
  const { stateDir, rest } = stateArg(argv);
  const action = rest[0];
  const attrs = parseCredentialRequest(io.stdin);
  if ((attrs.get('host') ?? '').toLowerCase() !== GITHUB_HOST) return 0;
  if (attrs.has('protocol') && attrs.get('protocol') !== 'https') return 0;
  const repository = githubRepository(attrs.get('path') ?? '');
  if (!repository) return 0;
  if (action === 'erase') {
    forgetCredential(stateDir, repository);
    return 0;
  }
  if (action !== 'get') return 0;
  const entry = await credentialFor(stateDir, repository, deps);
  io.write(`username=${TOKEN_USERNAME}\npassword=${entry.token}\n`);
  return 0;
}

// ── `motir hosted-gh` — the `gh` shim ──────────────────────────────────────

/** The repository a `gh` invocation acts on: its `-R`/`--repo`, else `origin`. */
function ghRepository(args: string[], cwd: string): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if ((a === '-R' || a === '--repo') && args[i + 1]) return githubRepository(args[i + 1]!);
    if (a.startsWith('--repo=')) return githubRepository(a.slice('--repo='.length));
  }
  // The CONFIGURED url, not `git remote get-url`: the latter applies any
  // `url.<base>.insteadOf` rewrite, and the repository a token is for is the one
  // the remote NAMES (MOTIR-6560).
  const origin = spawnSync('git', ['config', '--get', 'remote.origin.url'], {
    cwd,
    encoding: 'utf8',
  });
  return origin.status === 0 ? githubRepository(origin.stdout) : null;
}

/** The real `gh`: the first on PATH that is not this run's shim. */
function realGh(path: string, shimDir: string): string | null {
  for (const dir of path.split(delimiter)) {
    if (!dir || resolve(dir) === resolve(shimDir)) continue;
    const candidate = join(dir, 'gh');
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      /* not here */
    }
  }
  return null;
}

/**
 * `motir hosted-gh --state <dir> -- <gh args…>`: run the real `gh` with the
 * repository's token as `GH_TOKEN` for THAT invocation only — the variable
 * exists in the child's environment and nowhere else, so neither the agent's
 * environment nor this CLI's ever holds it.
 */
export async function hostedGhCommand(
  argv: string[],
  deps: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    now?: () => Date;
    issue?: IssueCredentials;
    spawn?: typeof spawnSync;
  } = {},
): Promise<number> {
  const { stateDir, rest } = stateArg(argv);
  const ghArgs = rest[0] === '--' ? rest.slice(1) : rest;
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const shimDir = join(stateDir, 'bin');
  const gh = realGh(env['PATH'] ?? '', shimDir);
  if (!gh) throw new CliError('`gh` is not installed in this hosted run.');
  const repository = ghRepository(ghArgs, cwd);
  const childEnv: NodeJS.ProcessEnv = { ...env };
  delete childEnv['GH_TOKEN'];
  delete childEnv['GITHUB_TOKEN'];
  if (repository) {
    childEnv['GH_TOKEN'] = (await credentialFor(stateDir, repository, deps)).token;
  }
  const result = (deps.spawn ?? spawnSync)(gh, ghArgs, { cwd, env: childEnv, stdio: 'inherit' });
  return result.status ?? 1;
}

/**
 * The hosted plumbing entry (`src/index.ts`): `git-credential` and `hosted-gh`
 * are invoked by git and by the `gh` shim, never typed by a person, so they are
 * served BEFORE the command tree — no staleness notice, no help, nothing on
 * stdout but the protocol. Returns null for any other argv.
 */
export async function runHostedPlumbing(argv: string[]): Promise<number | null> {
  if (argv[0] === 'git-credential') {
    const stdin = readFileSync(0, 'utf8');
    return gitCredentialCommand(argv.slice(1), {
      stdin,
      write: (s) => process.stdout.write(s),
    });
  }
  if (argv[0] === 'hosted-gh') return hostedGhCommand(argv.slice(1));
  return null;
}
