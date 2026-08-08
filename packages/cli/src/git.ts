import { spawnSync } from 'node:child_process';

// The SESSION-BRANCH plumbing for `motir auto` (Story 7.9 · Subtask 7.9.4 ·
// MOTIR-882) — the CLI's only git surface, and the only place it shells out to
// `git` / `gh`.
//
// The loop integrates every item of a run onto ONE session branch per repo and
// surfaces ONE pull request per repo at the end. Two facts shape everything
// here:
//
//  1. **The agent, not the CLI, writes code.** The server-generated prompt tells
//     the agent to branch from `origin/<sessionBranch>` and integrate back into
//     it — so the branch must EXIST ON ORIGIN before the run's first agent
//     starts, and the CLI's job at the end is to review-surface it, not to
//     author it.
//  2. **The CLI must not disturb the user's checkout.** It never checks out, and
//     it never creates a local branch: the session branch is created REMOTELY
//     (`git push origin origin/main:refs/heads/<branch>`), so a `motir auto` in
//     a repo with a dirty working tree is safe. The one local operation is a
//     `git fetch`, and the one conditional push covers an agent that integrated
//     locally without pushing.
//
// Every function takes an injectable {@link CommandRunner}, so the whole surface
// is unit-testable without a git repository, a network, or `gh` installed.

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Run one command in `cwd` and capture its result. Never throws. */
export type CommandRunner = (bin: string, args: string[], cwd: string) => CommandResult;

/** The production runner: a captured, non-shell `spawnSync` (no shell means an
 *  argument can never be re-interpreted as a command). */
export const execCommand: CommandRunner = (bin, args, cwd) => {
  const res = spawnSync(bin, args, { cwd, encoding: 'utf8', shell: false });
  if (res.error) {
    return { exitCode: 127, stdout: '', stderr: res.error.message };
  }
  return {
    exitCode: res.status ?? 1,
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
  };
};

/** The session branch a run uses. Deliberately carries NO `MOTIR-<n>` key: the
 *  status webhook parses a PR's branch AND title, and a session PR carries MANY
 *  items — a key in either would link the whole run to one of them and move
 *  only that card. The keys ride in the PR BODY, which is not parsed, and the
 *  real close-out is `motir done --session <branch>`. */
export function sessionBranchName(runId: string): string {
  return `motir/auto-${runId}`;
}

/** A filesystem-and-git-safe run id from a timestamp: `20260729-011830`. */
export function runIdFromDate(now: Date): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

export type EnsureBranchOutcome = 'created' | 'already_on_origin';

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitError';
  }
}

function requireOk(res: CommandResult, what: string): CommandResult {
  if (res.exitCode !== 0) {
    throw new GitError(`${what} failed: ${res.stderr || res.stdout || `exit ${res.exitCode}`}`);
  }
  return res;
}

/**
 * Make sure `branch` exists on `origin`, creating it from the LATEST
 * `origin/main` if it does not.
 *
 * Idempotent by design, because a run is resumable: a second `motir auto` in the
 * same repo, or a repo whose branch a previous iteration already created, finds
 * it present and leaves it exactly as it is — recreating it would rewind every
 * commit the agents have already integrated.
 */
export function ensureSessionBranchOnOrigin(
  cwd: string,
  branch: string,
  run: CommandRunner = execCommand,
): EnsureBranchOutcome {
  requireOk(run('git', ['fetch', 'origin'], cwd), 'git fetch origin');
  const exists = run(
    'git',
    ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`],
    cwd,
  );
  if (exists.exitCode === 0) return 'already_on_origin';
  // Push origin/main's commit straight to the new ref: no checkout, no local
  // branch, nothing in the user's working tree to clean up afterwards.
  requireOk(
    run('git', ['push', 'origin', `refs/remotes/origin/main:refs/heads/${branch}`], cwd),
    `creating ${branch} on origin`,
  );
  return 'created';
}

export type PushOutcome = 'pushed' | 'up_to_date' | 'no_local_branch';

/**
 * Push a LOCAL session branch that is ahead of its remote.
 *
 * The prompt already tells the agent to push after integrating, so the normal
 * outcome is `no_local_branch` (the agent worked in a worktree) or
 * `up_to_date`. This covers the agent that integrated locally and stopped —
 * without it, that work would never reach the pull request.
 */
export function pushSessionBranchIfAhead(
  cwd: string,
  branch: string,
  run: CommandRunner = execCommand,
): PushOutcome {
  const local = run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], cwd);
  if (local.exitCode !== 0) return 'no_local_branch';
  const ahead = run('git', ['rev-list', '--count', `origin/${branch}..${branch}`], cwd);
  if (ahead.exitCode === 0 && ahead.stdout.trim() === '0') return 'up_to_date';
  requireOk(run('git', ['push', 'origin', branch], cwd), `pushing ${branch}`);
  return 'pushed';
}

/** Whether the session branch actually carries work beyond `origin/main` — an
 *  empty branch gets no pull request (an empty PR is noise a human has to
 *  close). */
export function sessionBranchHasCommits(
  cwd: string,
  branch: string,
  run: CommandRunner = execCommand,
): boolean {
  const res = run('git', ['rev-list', '--count', `origin/main..origin/${branch}`], cwd);
  if (res.exitCode !== 0) return false;
  return Number.parseInt(res.stdout.trim(), 10) > 0;
}

/** One commit on a session branch — the agent's own narrative for its card. */
export interface SessionCommit {
  /** The subject line, as the agent wrote it. */
  subject: string;
  /** The message body beneath it — `''` when the commit has none. */
  body: string;
}

/**
 * Every commit the session branch adds, OLDEST FIRST — the order they were
 * dispatched in (MOTIR-2411).
 *
 * ⚠️ Read from THIS repo's checkout against THIS repo's branch. A multi-repo run
 * opens one pull request per repo, and a range read anywhere else would put
 * another repo's commits in this body.
 *
 * Uses an ASCII record separator rather than a delimiter that could appear in a
 * message: a commit body is arbitrary prose and will eventually contain any
 * printable string someone picks as a marker. `%x1e`/`%x1f` are control
 * characters git emits literally and no author types.
 *
 * A failed read yields `[]`, not a throw — by the time this runs the work is
 * already integrated and pushed, so a git hiccup must degrade the BODY, never
 * abandon the pull request (the same discipline `openSessionPr` applies to a
 * missing `gh`).
 */
export function sessionBranchCommits(
  cwd: string,
  branch: string,
  run: CommandRunner = execCommand,
): SessionCommit[] {
  const res = run(
    'git',
    ['log', '--reverse', '--format=%s%x1f%b%x1e', `origin/main..origin/${branch}`],
    cwd,
  );
  if (res.exitCode !== 0) return [];
  return res.stdout
    .split('\x1e')
    .map((record) => record.replace(/^\n+/, ''))
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const [subject = '', ...rest] = record.split('\x1f');
      return { subject: subject.trim(), body: rest.join('\x1f').trim() };
    });
}

export interface SessionPrResult {
  /** The PR URL when one was opened or already existed. */
  url: string | null;
  /** `opened` / `existing`, or `failed` with a message + the manual fallback. */
  outcome: 'opened' | 'existing' | 'failed';
  message?: string;
}

/**
 * Open (or find) the ONE pull request for a session branch.
 *
 * A `gh` failure is REPORTED, never thrown: by the time this runs the agents'
 * work is already integrated and pushed, so aborting the summary over a missing
 * `gh` would hide completed work behind a tooling gap. The caller prints the
 * message and the human opens the PR by hand.
 */
export function openSessionPr(
  cwd: string,
  input: { branch: string; title: string; body: string },
  run: CommandRunner = execCommand,
): SessionPrResult {
  const existing = run(
    'gh',
    ['pr', 'list', '--head', input.branch, '--state', 'open', '--json', 'url', '--jq', '.[0].url'],
    cwd,
  );
  if (existing.exitCode === 0 && existing.stdout.trim()) {
    return { url: existing.stdout.trim(), outcome: 'existing' };
  }
  const created = run(
    'gh',
    [
      'pr',
      'create',
      '--base',
      'main',
      '--head',
      input.branch,
      '--title',
      input.title,
      '--body',
      input.body,
    ],
    cwd,
  );
  if (created.exitCode !== 0) {
    return {
      url: null,
      outcome: 'failed',
      message:
        `Could not open the pull request for ${input.branch}: ` +
        `${created.stderr || created.stdout || `gh exited ${created.exitCode}`}`,
    };
  }
  // `gh pr create` prints the URL as its last line.
  const url = created.stdout.split('\n').filter(Boolean).pop() ?? null;
  return { url, outcome: 'opened' };
}
