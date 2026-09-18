import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { AgentRunResult } from '../agentRun.js';
import type { ParsedAgentCommand } from '../agentProfiles.js';
import {
  pluralize,
  queueReasonInWords,
  runCiWatchPhase,
  type CiWatchOutcome,
  type FixCheckout,
} from '../ciWatch.js';
import type {
  DispatchStopReason,
  MotirClient,
  RepairPullRequest,
  WorkItemRepairClaim,
  WorkItemRepairRefusal,
} from '../client.js';
import { resolveDispatchTarget } from '../dispatch.js';
import { createDispatchRunReporter } from '../dispatchRunReporter.js';
import { CliError } from '../errors.js';
import { execCommand, type CommandRunner } from '../git.js';
import type { LinkConfig } from '../config/linkConfig.js';
import { info } from '../output.js';
import { withProjectSession } from '../session.js';
import { requireAgent } from './auto.js';
import { CI_WATCH_EVENT, CI_WATCH_STOP_REASON } from './dispatch.js';

// `motir fix <key>` (Story MOTIR-5460 · MOTIR-5465) — hand an `implemented`
// card's RED pull requests to an agent, after the run that opened them has ended.
//
// ── Everything it needs already ships, except the claim and the checkout ─────
// The fixing loop is `runCiWatchPhase` exactly as `motir run` calls it: the same
// prompt (`renderFixPrompt`), the same five-attempt cap, the same green / pending
// / red rules. What a finished run lacks is (a) a claim that says *this repair is
// mine* without moving the card — the server's repair claim, which opens a `fix`
// dispatch run as its lock — and (b) a checkout of the pull requests' OWN
// branches, because the worktree the original run used is long gone.
//
// ── Every exit path CLOSES the run ────────────────────────────────────────────
// The item page reads an open `fix` run as *being fixed*. A command that died
// with its run open would tell everyone somebody is still working when nobody
// is — and would refuse every later `motir fix` as `taken`. So the close is
// idempotent and is reached from the refusal of a checkout, from green, from a
// give-up, from a thrown error, and from Ctrl-C.
//
// ── What it never does ────────────────────────────────────────────────────────
// It writes no status (the build moves the card, through `ciPromotion`), opens
// no pull request, and links nothing. It adds nothing to `motir auto` or
// `motir batch`.

export interface FixOptions {
  /** `--agent <cmd>` — the fixing agent (overrides MOTIR_AGENT). */
  agent?: string;
  /** `--report-log` — ALSO send the agent's output to Motir. Off by default. */
  reportLog?: boolean;
}

/** Injectable seams; never overridden in production. */
export interface FixDeps {
  /** The git runner, so a test scripts the checkout without a real remote. */
  run?: CommandRunner;
  /** Path existence, for the checkout resolution and a resumed worktree. */
  exists?: (path: string) => boolean;
  runAgentFn?: (input: {
    command: ParsedAgentCommand;
    prompt: string;
    cwd: string;
  }) => Promise<AgentRunResult>;
  wait?: () => Promise<void>;
  maxCiPolls?: number;
  /**
   * Install the interrupt handler and return its remover. Production binds
   * SIGINT; a test calls the handler directly to prove the run is closed.
   */
  onInterrupt?: (handler: () => void) => () => void;
  /** How the process ends after an interrupt. `process.exit` in production. */
  exit?: (code: number) => void;
}

const bindSigint = (handler: () => void): (() => void) => {
  process.on('SIGINT', handler);
  return () => {
    process.off('SIGINT', handler);
  };
};

/**
 * The words for each refusal — TOTAL over the server's reason vocabulary, so a
 * new reason is a type error here rather than a silent generic line.
 */
const REFUSAL_LINES = {
  not_implemented: () =>
    'it is not at Implemented. `motir fix` picks up a card whose run has ended and whose pull ' +
    'requests went red afterwards.',
  repair_on_run_target: (claim) =>
    `its pull requests belong to the run on ${claim.runTargetKey ?? 'its parent'} — ` +
    `run \`motir fix ${claim.runTargetKey ?? '<that key>'}\` instead.`,
  no_pull_requests: () => 'it has no pull requests, so there is nothing to repair.',
  ci_running: () =>
    'its checks are still running and nothing has failed yet. Wait for the verdict, and run ' +
    'this again if it goes red.',
  not_failing: () => 'nothing is failing on its open pull requests, so there is nothing to repair.',
} as const satisfies Record<WorkItemRepairRefusal, (claim: WorkItemRepairClaim) => string>;

/** A refused repair, in words. Exported so the vocabulary can be pinned. */
export function renderRepairRefusal(claim: WorkItemRepairClaim): string {
  if (claim.outcome === 'taken') {
    const who = claim.holder?.name ?? 'somebody else';
    const since = claim.startedAt ? ` since ${claim.startedAt}` : '';
    return [
      `${claim.key}: already being fixed by ${who}${since} — not starting a second repair.`,
      'Two agents pushing to one pull request undo each other. Nothing was changed.',
    ].join('\n');
  }
  // `not_repairable` is the only other refusal; a missing reason is a server
  // that predates the field, and the generic line is the honest answer to it.
  const reason = claim.reason;
  const why = reason ? REFUSAL_LINES[reason](claim) : 'the server refused the repair.';
  return `${claim.key}: not repairable — ${why}\nNothing was changed.`;
}

type Prepared = { ok: true; checkouts: FixCheckout[] } | { ok: false; message: string };

/**
 * CHECK OUT each failing pull request's OWN branch in a worktree beside its
 * repository's checkout — ON the branch, never detached, so the agent's push
 * updates the pull request that is already open.
 *
 * A resumed repair (`mine`) finds its worktree still there and reuses it when it
 * is on the right branch. Anything else that is in the way is a refusal: this
 * command never resets, removes or re-points a worktree it did not just make.
 */
export function prepareCheckouts(input: {
  key: string;
  pullRequests: readonly RepairPullRequest[];
  rootDir: string;
  config: LinkConfig;
  run: CommandRunner;
  exists: (path: string) => boolean;
}): Prepared {
  const checkouts: FixCheckout[] = [];
  for (const pr of input.pullRequests) {
    const repoName = pr.repo.slice(pr.repo.indexOf('/') + 1);
    const target = resolveDispatchTarget(input.rootDir, input.config, repoName, {
      exists: input.exists,
    });
    if (target.reason !== 'repo_checkout' || target.repoPath === null) {
      return {
        ok: false,
        message:
          `${pr.repo}#${pr.number}: no local checkout of ${repoName}` +
          `${target.repoPath ? ` at ${target.repoPath}` : ''}. Clone it there, ` +
          `or map it in .motir.json, then run \`motir fix ${input.key}\` again.`,
      };
    }
    const repoPath = target.repoPath;
    const branch = pr.headRef;
    const path = join(
      dirname(repoPath),
      `${basename(repoPath)}-fix-${input.key.toLowerCase()}-${pr.number}`,
    );
    const git = (args: string[], cwd = repoPath) => input.run('git', args, cwd);
    const fail = (what: string, detail: string): Prepared => ({
      ok: false,
      message: `${pr.repo}#${pr.number}: ${what}${detail ? ` — ${detail}` : ''}.`,
    });

    const fetched = git(['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    if (fetched.exitCode !== 0) {
      return fail(`could not fetch its branch \`${branch}\``, fetched.stderr);
    }

    if (input.exists(path)) {
      const head = git(['rev-parse', '--abbrev-ref', 'HEAD'], path);
      if (head.exitCode !== 0 || head.stdout !== branch) {
        return fail(
          `${path} already exists and is not a checkout of \`${branch}\``,
          'move it aside and run this again',
        );
      }
    } else {
      const local = git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
      const added =
        local.exitCode === 0
          ? git(['worktree', 'add', path, branch])
          : git(['worktree', 'add', '--track', '-b', branch, path, `origin/${branch}`]);
      if (added.exitCode !== 0) {
        return fail(`could not check out \`${branch}\` at ${path}`, added.stderr);
      }
    }

    // Bring a local branch up to the pull request's head. Fast-forward ONLY: a
    // local branch that has diverged from the pull request holds work nobody
    // pushed, and merging it in would ship it under a repair.
    const ff = git(['merge', '--ff-only', `origin/${branch}`], path);
    if (ff.exitCode !== 0) {
      return fail(`the local \`${branch}\` has diverged from the pull request`, ff.stderr);
    }
    const on = git(['rev-parse', '--abbrev-ref', 'HEAD'], path);
    if (on.stdout !== branch) {
      return fail(`the checkout at ${path} is not on \`${branch}\``, on.stdout);
    }
    checkouts.push({ repo: pr.repo, branch, path });
  }
  return { ok: true, checkouts };
}

/** How a repair that did not go green is reported — the check, the repository,
 *  and how many attempts were spent. */
export function renderRepairGaveUp(input: {
  key: string;
  watch: Extract<CiWatchOutcome, { kind: 'gave_up' | 'fix_failed' }>;
  pullRequests: readonly RepairPullRequest[];
}): string {
  const { key, watch } = input;
  const head =
    watch.kind === 'gave_up'
      ? `${key}: the repair gave up after ${pluralize(watch.attempts, 'attempt')}.`
      : `${key}: the repair stopped after ${pluralize(watch.attempts, 'attempt')} — ${watch.detail}.`;
  const lines = [head];
  for (const pr of input.pullRequests) {
    // A queue-failing pull request names the QUEUE's check (MOTIR-5720) — its own
    // `failingChecks` are usually empty, because its own checks are green.
    const checks = pr.queueExit
      ? `in the merge queue — ${pr.queueExit.failingCheckName ?? queueReasonInWords(pr.queueExit.rawReason)}`
      : pr.failingChecks.length > 0
        ? pr.failingChecks.join(', ')
        : 'unknown checks';
    lines.push(`  ${pr.repo}#${pr.number} — failing: ${checks} (${pr.url})`);
  }
  lines.push(
    `The card stays at Implemented. Look at the failure, then run \`motir fix ${key}\` again.`,
  );
  return lines.join('\n');
}

export async function fixCommand(key: string, opts: FixOptions, deps: FixDeps = {}): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) throw new CliError('A work item key is required, e.g. `motir fix ACME-7`.');
  await withProjectSession(async (session) => {
    const { client, link } = session;
    // The agent is resolved BEFORE the claim: a repair nobody can run must not
    // open a run that then has to be closed as a failure.
    const agent = requireAgent({ ...opts, print: false }, 'motir fix');

    const claim = await client.claimWorkItemRepair(trimmed);
    if (claim.outcome !== 'claimed' && claim.outcome !== 'mine') {
      info(renderRepairRefusal(claim));
      process.exitCode = 1;
      return;
    }
    await repair({ client, claim, rootDir: link.dir, config: link.config, agent, opts, deps });
  });
}

async function repair(input: {
  client: MotirClient;
  claim: WorkItemRepairClaim;
  rootDir: string;
  config: LinkConfig;
  agent: ReturnType<typeof requireAgent>;
  opts: FixOptions;
  deps: FixDeps;
}): Promise<void> {
  const { client, claim, agent, opts, deps } = input;
  const key = claim.key;
  const reporter = createDispatchRunReporter({ client, reportLogBodies: opts.reportLog === true });
  // `claimed` / `mine` always carry the run — the server opened it.
  reporter.adopt(claim.runId as string);

  let closed = false;
  const close = async (stopReason: DispatchStopReason): Promise<void> => {
    if (closed) return;
    closed = true;
    await reporter.close(stopReason);
  };
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const detach = (deps.onInterrupt ?? bindSigint)(() => {
    info('');
    info(`Interrupted — closing the repair of ${key}.`);
    void close('interrupted').finally(() => exit(130));
  });

  try {
    reporter.event({
      kind: 'run_opened',
      data: { command: 'fix', key, outcome: claim.outcome },
    });

    const prepared = prepareCheckouts({
      key,
      pullRequests: claim.pullRequests,
      rootDir: input.rootDir,
      config: input.config,
      run: deps.run ?? execCommand,
      exists: deps.exists ?? existsSync,
    });
    if (!prepared.ok) {
      info(prepared.message);
      reporter.event({ kind: 'card_settled', workItemKey: key, disposition: 'failed' });
      process.exitCode = 1;
      await close('halted');
      return;
    }

    info(
      `${key}: ${claim.outcome === 'mine' ? 'resuming' : 'starting'} the repair of ` +
        `${claim.pullRequests.map((pr) => `${pr.repo}#${pr.number}`).join(', ')}.`,
    );
    for (const c of prepared.checkouts) info(`  ${c.repo} — ${c.branch} at ${c.path}`);
    reporter.event({
      kind: 'checkout_ready',
      workItemKey: key,
      disposition: 'running',
      data: { checkouts: prepared.checkouts },
    });

    const watch = await runCiWatchPhase({
      client,
      key,
      title: claim.title,
      agent: agent.parsed,
      cwd: prepared.checkouts[0]!.path,
      checkouts: prepared.checkouts,
      report: (line) => info(line),
      ...(deps.wait ? { wait: deps.wait } : {}),
      ...(deps.runAgentFn ? { runAgentFn: deps.runAgentFn } : {}),
      ...(deps.maxCiPolls === undefined ? {} : { maxPolls: deps.maxCiPolls }),
    });
    reporter.event({ kind: CI_WATCH_EVENT[watch.kind], workItemKey: key, data: watch });

    if (watch.kind === 'gave_up' || watch.kind === 'fix_failed') {
      // Re-claim to NAME the failing checks now: the repair is still ours, so
      // this is `mine` and writes nothing, and it is the one read that carries
      // check names. A failure here falls back to the pull requests we started
      // with, which still name the repository and the attempt count.
      const now = await client.claimWorkItemRepair(key).catch(() => null);
      const pullRequests =
        now && now.outcome === 'mine' && now.pullRequests.length > 0
          ? now.pullRequests
          : claim.pullRequests;
      info('');
      info(renderRepairGaveUp({ key, watch, pullRequests }));
      reporter.event({ kind: 'card_settled', workItemKey: key, disposition: 'failed' });
      process.exitCode = 1;
    } else {
      reporter.event({ kind: 'card_settled', workItemKey: key, disposition: 'implemented' });
    }
    await close(CI_WATCH_STOP_REASON[watch.kind]);
  } catch (err) {
    await close('halted');
    throw err;
  } finally {
    detach();
  }
}
