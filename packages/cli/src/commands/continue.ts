import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WorkItemContinueClaim } from '../client.js';
import { resolveDispatchTarget } from '../dispatch.js';
import { createDispatchRunReporter } from '../dispatchRunReporter.js';
import { CliError } from '../errors.js';
import { execCommand, type CommandRunner } from '../git.js';
import type { LinkConfig } from '../config/linkConfig.js';
import { info } from '../output.js';
import { withProjectSession } from '../session.js';
import { requireAgent } from './auto.js';
import {
  deliver,
  resolveOwnerId,
  runClaimedScope,
  type DeliveryDeps,
  type RunOptions,
} from './dispatch.js';
import { claimScopeForRun } from './scope.js';
import { runIdFromDate } from '../git.js';

// `motir continue <key>` (Story MOTIR-6526 · MOTIR-6533,
// `docs/decisions/run-death-keeps-work.md` §4) — carry on the work of a run that
// DIED, on the branch it left, from any machine, by any member who may edit.
//
// ── Two halves Motir already trusts, and the glue between them ───────────────
// The FRONT half is `motir fix`'s: a server claim that takes the card over
// without moving its status (here the continue claim, whose open `continue` run
// is the lock), then a checkout of somebody else's branch that never destroys
// anything. The BACK half is `motir run`'s own `deliver` — the push check, the
// move to Implemented, the CI watch — called, not copied, so a continued card
// reaches Implemented exactly as a fresh one does.
//
// ── Why it is not `motir run` ────────────────────────────────────────────────
// `run` starts work on a card that is waiting; `continue` carries on work that
// already began. A command that sometimes started fresh and sometimes resumed
// somebody else's branch is one a person could not predict (the decision's
// *Rejected*), so continuing has its own name and its own lock.
//
// ── What it never does ───────────────────────────────────────────────────────
// It never resets, cleans, stashes or re-points a worktree: the dead run's
// worktree is reused AS FOUND, dirty or clean — the claim proved its run dead, so
// nobody else is in it — and one on another branch is a refusal naming it.

/** What `motir continue` reads — its own flags, registered in `program.ts`. */
export interface ContinueOptions {
  /** `--agent <cmd>` — the continuing agent (overrides MOTIR_AGENT). */
  agent?: string;
  /** `--report-log` — ALSO send the agent's output to Motir. Off by default. */
  reportLog?: boolean;
  /** `--max <n>` — a PARENT continue: stop after n cards. */
  max?: string;
  /** `--keep-going` — a PARENT continue: carry on past a failed agent. */
  keepGoing?: boolean;
}

/** Injectable seams; never overridden in production. */
export interface ContinueDeps extends DeliveryDeps {
  /** The git runner, so a test scripts the checkout without a real remote. */
  run?: CommandRunner;
  /** Path existence, for the checkout resolution and a reused worktree. */
  exists?: (path: string) => boolean;
}

/**
 * The words for each refusal — TOTAL over the claim's reason vocabulary, so a new
 * reason is a type error here rather than a silent generic line. Each names what
 * to do instead.
 */
const REFUSAL_LINES = {
  run_alive: (c: WorkItemContinueClaim) =>
    `its run is still alive${c.holder ? ` (${c.holder.name}'s)` : ''}. Wait for it to finish, ` +
    'or — if it has really stopped — try again in a few minutes, once Motir has stopped ' +
    'hearing from it.',
  use_fix: (c: WorkItemContinueClaim) =>
    'its pull request is already open, so there is nothing to continue — its checks decide ' +
    `from here. If they go red, run \`motir fix ${c.key}\`.`,
  not_in_progress: (c: WorkItemContinueClaim) =>
    `it is not In Progress. To start it, run \`motir run ${c.key}\`.`,
  continue_the_parent: (c: WorkItemContinueClaim) =>
    `it was run as part of ${c.parentKey ?? 'its parent'}, so it is continued from there: ` +
    `run \`motir continue ${c.parentKey ?? '<the parent>'}\`.`,
  no_dead_run: () => 'no run of it has died, so there is nothing to continue.',
  no_branch: (c: WorkItemContinueClaim) =>
    'the run that died left no branch to continue on. Start over instead: set it to To Do ' +
    `and run \`motir run ${c.key}\`.`,
} as const satisfies Record<
  NonNullable<WorkItemContinueClaim['reason']>,
  (claim: WorkItemContinueClaim) => string
>;

/** A refused continue, in words. Exported so the vocabulary can be pinned. */
export function renderContinueRefusal(claim: WorkItemContinueClaim): string {
  if (claim.outcome === 'taken') {
    const who = claim.holder?.name ?? 'somebody else';
    const since = claim.startedAt ? ` since ${claim.startedAt}` : '';
    return [
      `${claim.key}: already being continued by ${who}${since} — not starting a second agent.`,
      'Two agents on one branch undo each other. Nothing was changed.',
    ].join('\n');
  }
  const reason = claim.reason;
  const why = reason ? REFUSAL_LINES[reason](claim) : 'the server refused the continue.';
  return `${claim.key}: nothing to continue — ${why}\nNothing was changed.`;
}

/** The takeover line — whose work this is, and where it is. */
export function renderTakeover(claim: WorkItemContinueClaim): string {
  const from = claim.previousAssignee
    ? `Took ${claim.key} over from ${claim.previousAssignee.name}`
    : `Took ${claim.key} over`;
  const dead = claim.deadRun
    ? ` — its last run (${claim.deadRun.dispatcher?.name ?? 'somebody'}'s) was last heard from ${claim.deadRun.lastHeardAt}`
    : '';
  return `${from}${dead}.\nContinuing on ${claim.branch ?? 'its branch'}.`;
}

type Prepared = { ok: true; path: string } | { ok: false; message: string };

/**
 * CHECK OUT the dead run's branch in the worktree the CONTINUE prompt names
 * (`../<repo>-<key>` beside the repository's checkout), so the agent — which is
 * told to reuse that worktree when it is there — finds it ready.
 *
 * Reused AS FOUND when it is already on the branch, dirty or clean: the claim
 * proved its run dead, so its uncommitted work is the dead run's and is kept.
 * On another branch it is a REFUSAL naming it. Otherwise the branch is added,
 * tracking `origin/<branch>`. Nothing is ever reset.
 */
export function prepareContinueCheckout(input: {
  key: string;
  branch: string;
  targetRepo: string | null;
  rootDir: string;
  config: LinkConfig;
  run: CommandRunner;
  exists: (path: string) => boolean;
}): Prepared {
  const target = resolveDispatchTarget(input.rootDir, input.config, input.targetRepo, {
    exists: input.exists,
  });
  if (target.reason !== 'repo_checkout' || target.repoPath === null) {
    return {
      ok: false,
      message:
        `${input.key}: no local checkout of ${input.targetRepo ?? 'its repository'}` +
        `${target.repoPath ? ` at ${target.repoPath}` : ''}. Clone it there, or map it in ` +
        `.motir.json, then run \`motir continue ${input.key}\` again.`,
    };
  }
  const repoPath = target.repoPath;
  const repoName = input.targetRepo ?? repoPath.split(/[\\/]/).pop() ?? 'repo';
  // The SAME path the prompt's continue workflow names (`worktreeDir`).
  const path = join(dirname(repoPath), `${repoName}-${input.key.toLowerCase()}`);
  const git = (args: string[], cwd = repoPath) => input.run('git', args, cwd);
  const fail = (what: string, detail: string): Prepared => ({
    ok: false,
    message: `${input.key}: ${what}${detail ? ` — ${detail}` : ''}. Nothing was changed.`,
  });

  const fetched = git([
    'fetch',
    'origin',
    `+refs/heads/${input.branch}:refs/remotes/origin/${input.branch}`,
  ]);
  if (fetched.exitCode !== 0) {
    return fail(`could not fetch its branch \`${input.branch}\``, fetched.stderr);
  }

  if (input.exists(path)) {
    const head = git(['rev-parse', '--abbrev-ref', 'HEAD'], path);
    if (head.exitCode !== 0 || head.stdout !== input.branch) {
      return fail(
        `${path} already exists and is on \`${head.stdout || 'something else'}\`, not \`${input.branch}\``,
        'move it aside and run this again',
      );
    }
    return { ok: true, path };
  }
  const local = git(['rev-parse', '--verify', '--quiet', `refs/heads/${input.branch}`]);
  const added =
    local.exitCode === 0
      ? git(['worktree', 'add', path, input.branch])
      : git(['worktree', 'add', '--track', '-b', input.branch, path, `origin/${input.branch}`]);
  if (added.exitCode !== 0) {
    return fail(`could not check out \`${input.branch}\` at ${path}`, added.stderr);
  }
  return { ok: true, path };
}

export async function continueCommand(
  key: string,
  opts: ContinueOptions,
  deps: ContinueDeps = {},
): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) throw new CliError('A work item key is required, e.g. `motir continue ACME-7`.');
  await withProjectSession(async (session) => {
    const { client, link } = session;
    // The agent is resolved BEFORE the claim: a continue nobody can run must not
    // take a card over and then have to hand it back.
    const agent = requireAgent({ ...opts, print: false }, 'motir continue');

    const claim = await client.claimWorkItemContinue(trimmed);
    if (claim.outcome !== 'claimed' && claim.outcome !== 'mine') {
      info(renderContinueRefusal(claim));
      process.exitCode = 1;
      return;
    }
    info(renderTakeover(claim));

    if (claim.mode === 'parent') {
      await continueParent({ session, claim, opts, deps, agent });
      return;
    }

    // The run the SERVER opened, adopted — so this process heartbeats it and
    // closes it `interrupted` on a signal (MOTIR-6530), exactly as a `motir run`.
    const reporter = createDispatchRunReporter({
      client,
      reportLogBodies: opts.reportLog === true,
    });
    reporter.adopt(claim.runId as string);

    const dispatch = await client.dispatchPrompt(claim.key, {
      ...(claim.deadRun ? { continueFrom: claim.deadRun.id } : {}),
    });

    const prepared = prepareContinueCheckout({
      key: claim.key,
      branch: claim.branch as string,
      targetRepo: dispatch.targetRepo,
      rootDir: link.dir,
      config: link.config,
      run: deps.run ?? execCommand,
      exists: deps.exists ?? existsSync,
    });
    if (!prepared.ok) {
      info(prepared.message);
      reporter.event({ kind: 'card_settled', workItemKey: claim.key, disposition: 'failed' });
      await reporter.close('halted');
      process.exitCode = 1;
      return;
    }
    info(`  ${claim.branch} at ${prepared.path}`);
    reporter.event({
      kind: 'checkout_ready',
      workItemKey: claim.key,
      disposition: 'running',
      data: { branch: claim.branch, path: prepared.path },
    });

    // `motir run`'s own delivery — the agent, the push check, Implemented, the CI
    // watch — with the run already held.
    await deliver({
      session,
      command: 'continue',
      key: claim.key,
      title: claim.title,
      dispatch,
      opts,
      deps,
      reporter,
    });
  });
}

/**
 * `motir continue <PARENT>` (Story MOTIR-6526 · MOTIR-6535) — the dead run was a
 * SCOPED run over this container, so the WHOLE scope resumes: on the dead run's
 * session branch (with `origin/main` merged into it first), through its existing
 * draft pull request (`openSessionPr` finds it by head, so no second one opens),
 * dispatching only what has not landed.
 *
 * The drain is `motir run <parent>`'s own (`runClaimedScope`), not a copy: the
 * scope claim recomputes the set from what is ready NOW — the claim re-assigned
 * the dead run's in-flight legs to the caller, so they come back as `mine`, and a
 * leg already Implemented or later is not in that set at all.
 */
async function continueParent(input: {
  session: Parameters<Parameters<typeof withProjectSession>[0]>[0];
  claim: WorkItemContinueClaim;
  opts: ContinueOptions;
  deps: ContinueDeps;
  agent: ReturnType<typeof requireAgent>;
}): Promise<void> {
  const { session, claim, opts, deps, agent } = input;
  const reporter = createDispatchRunReporter({
    client: session.client,
    reportLogBodies: opts.reportLog === true,
  });
  reporter.adopt(claim.runId as string);

  if (claim.landedKeys.length > 0) {
    info(`Already landed — not run again: ${claim.landedKeys.join(', ')}.`);
    reporter.event({ kind: 'log', data: { alreadyLanded: claim.landedKeys } });
  }

  const target = { kind: 'work_item' as const, key: claim.key };
  const ownerId = await resolveOwnerId(session.client);
  // `continue` registers only its own flags; the scope helpers read the rest as unset.
  const runOpts: RunOptions = { ...opts };
  const claimed = await claimScopeForRun(session, target, runOpts, ownerId);
  if (!claimed) {
    // Nothing left to dispatch (or the scope claim refused and said why).
    await reporter.close('completed');
    return;
  }
  const branch = claim.branch as string;
  // The run id the session branch was minted from, so the pull request's title
  // and body keep naming the run the reviewer has been following.
  const runId = branch.startsWith('motir/auto-')
    ? branch.slice('motir/auto-'.length)
    : runIdFromDate((deps.now ?? (() => new Date()))());
  await runClaimedScope({
    session,
    target,
    claimed,
    opts: runOpts,
    deps,
    agent,
    runId,
    branch,
    reporter,
    resumeBranch: true,
  });
}
