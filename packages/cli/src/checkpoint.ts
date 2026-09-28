import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execCommand, type CommandRunner } from './git.js';
import type { DispatchPrompt } from './client.js';
import type { DispatchTarget } from './dispatch.js';
import type { DispatchRunReporter } from './dispatchRunReporter.js';

// A RUN CHECKPOINTS ITS WORK (Story MOTIR-683 · MOTIR-6539).
//
// ── Why ────────────────────────────────────────────────────────────────────
// A run that dies — its agent killed, its container reaped, its laptop closed —
// keeps only what reached origin. The dispatch prompt asks the agent to push,
// but nothing guaranteed it: an agent that commits and never pushes leaves its
// work in a checkout that, in a hosted run, is destroyed with the container. The
// card then waits for `motir continue` with nothing to continue from
// (`docs/decisions/hosted-run-runs-the-cli-as-the-app.md`; the run-dies decision).
//
// So while an agent works, the CLI pushes the card's WORK BRANCH in every
// repository of the leg whenever it holds commits origin does not have yet.
//
// ── What it pushes, and what it never touches ──────────────────────────────
//   * The WORK BRANCH the prompt told the agent to create (`workBranch` on the
//     dispatch payload) — the same name in every repository. Its commits are the
//     AGENT's; the CLI never commits on its behalf.
//   * NEVER the session branch. In `session_lineage` mode the agent integrates
//     into it itself; pushing unfinished work there would put it on the shared
//     review surface, and a later rewrite by the agent would then be refused at
//     its own integration push. A dead child's work branch — branched from the
//     session branch — is where `motir continue` finds it.
//   * Only a branch that holds commits NO remote-tracking ref reaches. A freshly
//     created branch equal to its base is not pushed: an empty remote branch named
//     after the card would make the MOTIR-3004 push check (`workReachedRemote`)
//     report work that does not exist.
//
// ── How it fails ───────────────────────────────────────────────────────────
// Never loudly. A failed push is ONE `log` event on the run per repository and
// commit, and is tried again on the next tick. A checkpoint can make a run safer;
// it can never make a run fail.

/** One repository of the leg, as `checkout_ready` names it. */
export interface LegBranch {
  repository: string | null;
  /** The branch the pull request is opened from: the session branch in
   *  `session_lineage` mode, else the work branch. `null` when the server did not
   *  say (a server older than MOTIR-6539 sends no `workBranch`). */
  branch: string | null;
  /** The branch the agent's commits are made on, and the one checkpoints push. */
  workBranch: string | null;
}

/** The branches of every repository of a leg, in the payload's order. */
export function legBranches(
  dispatch: Pick<DispatchPrompt, 'sessionBranch' | 'workBranch'>,
  targets: Pick<DispatchTarget, 'targetRepo'>[],
): LegBranch[] {
  const workBranch = dispatch.workBranch ?? null;
  const branch = dispatch.sessionBranch ?? workBranch;
  return targets.map((t) => ({ repository: t.targetRepo, branch, workBranch }));
}

/** The default interval between checkpoints: one minute. */
export const CHECKPOINT_INTERVAL_MS = 60_000;

export interface CheckpointInput {
  key: string;
  /** The leg's repositories. Only those whose checkout exists on disk are
   *  checkpointed — a bootstrap target has none until the agent makes it. */
  targets: Pick<DispatchTarget, 'targetRepo' | 'repoPath' | 'cwd'>[];
  workBranch: string | null;
  /**
   * Each repository's OWN work branch, when they differ (MOTIR-6793) — a continue
   * resumes every repository on the branch ITS dead run left there, which is not
   * the card's fresh branch. A repository absent here falls back to `workBranch`.
   */
  branches?: Pick<LegBranch, 'repository' | 'workBranch'>[];
  reporter: Pick<DispatchRunReporter, 'event'>;
  run?: CommandRunner;
  intervalMs?: number;
}

export interface Checkpoints {
  /** One tick now — pushes whatever has advanced. Serialized with the timer. */
  tick(): void;
  /** Stop the timer, after one last tick so a killed agent's final commits are
   *  saved too. Idempotent. */
  stop(): void;
}

const NO_CHECKPOINTS: Checkpoints = { tick() {}, stop() {} };

/** The checkout a target's branch lives in, or null when there is none on disk. */
function checkoutOf(t: Pick<DispatchTarget, 'repoPath' | 'cwd'>): string | null {
  const dir = t.repoPath ?? t.cwd;
  return existsSync(join(dir, '.git')) ? dir : null;
}

/**
 * Start checkpointing a leg. The timer is `unref`'d, so it never holds a
 * process open on its own. With no work branch (a manual item, or a server that
 * does not name one) there is nothing to push and nothing is started.
 */
export function startCheckpoints(input: CheckpointInput): Checkpoints {
  const { key, reporter } = input;
  const branchOf = (repository: string | null): string | null =>
    input.branches?.find((b) => b.repository === repository)?.workBranch ?? input.workBranch;
  const run = input.run ?? execCommand;
  const repos = input.targets
    .map((t) => ({ repository: t.targetRepo, dir: checkoutOf(t), branch: branchOf(t.targetRepo) }))
    .filter(
      (r): r is { repository: string | null; dir: string; branch: string } =>
        r.dir !== null && r.branch !== null,
    );
  if (repos.length === 0) return NO_CHECKPOINTS;

  const pushed = new Map<string, string>();
  const reported = new Set<string>();
  let stopped = false;

  const tick = (): void => {
    for (const { repository, dir, branch: workBranch } of repos) {
      const head = run(
        'git',
        ['rev-parse', '--verify', '--quiet', `refs/heads/${workBranch}`],
        dir,
      );
      const sha = head.exitCode === 0 ? head.stdout.trim() : '';
      if (sha === '' || pushed.get(dir) === sha) continue;
      // Commits origin does not have yet — none means nothing worth pushing.
      const ahead = run('git', ['rev-list', '--count', sha, '--not', '--remotes'], dir);
      if (ahead.exitCode !== 0 || Number(ahead.stdout.trim()) === 0) continue;
      const res = run('git', ['push', '--quiet', '-u', 'origin', workBranch], dir);
      if (res.exitCode === 0) {
        pushed.set(dir, sha);
        continue;
      }
      const once = `${dir}\u0000${sha}`;
      if (reported.has(once)) continue;
      reported.add(once);
      reporter.event({
        kind: 'log',
        workItemKey: key,
        body:
          `[motir] checkpoint push of ${workBranch}${repository ? ` in ${repository}` : ''} ` +
          `failed; retrying on the next tick: ${(res.stderr || res.stdout).split('\n')[0] ?? ''}\n`,
      });
    }
  };

  const timer = setInterval(tick, input.intervalMs ?? CHECKPOINT_INTERVAL_MS);
  timer.unref?.();
  return {
    tick,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      tick();
    },
  };
}
