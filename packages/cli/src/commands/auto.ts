import { CliError } from '../errors.js';
import { info } from '../output.js';
import { parseKinds } from './read.js';
import {
  ensureInProgress,
  resolveAgent,
  resolveOwnerId,
  type DeliveryOptions,
} from './dispatch.js';
import { withProjectSession, type ProjectSession } from '../session.js';
import { runAgent } from '../agentRun.js';
import { addExclude, clearExcludes, readExcludes, removeExclude } from '../sessionExcludes.js';
import {
  checkBootstrapCheckout,
  cwdReasonLabel,
  resolveDispatchTarget,
  type DispatchTarget,
} from '../dispatch.js';
import {
  autoExitCode,
  classifyReadyItem,
  formatDuration,
  planReviewUrl,
  renderAutoSummary,
  renderSessionPrBody,
  sessionPrTitle,
  type AutoSummary,
  type DispatchRecord,
  type PlanningRecord,
  type PrReport,
  type RepoSession,
  type SkipRecord,
  type StopReason,
} from '../autoLoop.js';
import {
  ensureSessionBranchOnOrigin,
  execCommand,
  GitError,
  openSessionPr,
  pushSessionBranchIfAhead,
  runIdFromDate,
  sessionBranchCommits,
  sessionBranchHasCommits,
  sessionBranchName,
  type CommandRunner,
} from '../git.js';
import { deriveAgentHarness } from '../agentProfiles.js';
import type { DispatchItem, DispatchPrompt, MotirClient } from '../client.js';

// `motir auto` — THE SEQUENTIAL WHILE LOOP (Story 7.9 · Subtask 7.9.4 ·
// MOTIR-882). Drain the ready set unattended: one item per iteration, strictly
// one at a time, until the server says there is nothing left.
//
// ── The shape is a WHILE loop, never a batch drain ──────────────────────────
// The loop asks the server for exactly ONE item per iteration (`next_ready`)
// and never materializes a list. That is not a style choice: the ready set
// CHANGES while the run executes. Integrating item A unlocks its dependents,
// which were not ready — and may not even have existed — when the run started.
// A pre-computed plan-of-the-run would therefore be stale by iteration two and
// would silently cap the run at whatever happened to be ready at second zero.
// There is deliberately no code path here that reads more than one item ahead.
//
// ── Session-branch mode is the ONLY mode ────────────────────────────────────
// Items do not each get a pull request. The run opens ONE session branch per
// repo it dispatches into (lazily, on that repo's first item) and every item's
// work is integrated onto it; at the end the CLI surfaces ONE pull request per
// repo, which is the run's single human review gate. MAIN IS NEVER AUTO-
// ADVANCED — not by the CLI, and not by the prompt, whose session-lineage GIT
// WORKFLOW section instructs the agent to integrate into the session branch and
// explicitly not to open a pull request. Nothing reaches Done until a human
// merges that PR and runs `motir done --session <branch>`.

export interface AutoOptions extends DeliveryOptions {
  kinds?: string;
  /** `--max <n>` — cap the dispatches this invocation makes. */
  max?: string;
  /** `--keep-going` — continue past a failed agent instead of halting. */
  keepGoing?: boolean;
  /** `--reset` — clear this project's persisted exclude list first. */
  reset?: boolean;
  /** `--include-planning` — fire an AI expansion for each unexpanded epic/story
   *  the ready set hands back, instead of skipping it (MOTIR-886). */
  includePlanning?: boolean;
}

/** Injectable seams; never overridden in production. */
export interface AutoDeps {
  run?: CommandRunner;
  now?: () => Date;
  clock?: () => number;
  /** The agent launcher. Injected by the tests so the loop can be driven with a
   *  scripted agent — the fixture the acceptance criteria are written against. */
  runAgentFn?: typeof runAgent;
}

/** A resolved agent — `motir auto` refuses to start without one, so every
 *  downstream signature takes the non-null form. */
type ResolvedAgent = NonNullable<ReturnType<typeof resolveAgent>>;

/**
 * Parse `--max`. A cap that silently means "no cap" because it did not parse is
 * the worst outcome for an unattended loop, so anything non-positive is a hard
 * error rather than an ignored flag.
 */
export function parseMax(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || String(n) !== raw.trim()) {
    throw new CliError(`--max must be a positive whole number, got "${raw}".`);
  }
  return n;
}

/**
 * `motir auto` REQUIRES an agent. `--print` is the copy-paste-into-your-agent
 * mode, and there is no human in an unattended loop to copy anything — so it is
 * an error with guidance rather than a silently degraded run.
 */
function requireAgent(opts: AutoOptions): ResolvedAgent {
  if (opts.print) {
    throw new CliError('`motir auto` cannot run in --print mode.', {
      hint: 'An unattended loop has nobody to paste a prompt. Use `motir next --print` for one item, or pass --agent <cmd>.',
    });
  }
  const agent = resolveAgent(opts);
  if (!agent) {
    throw new CliError('`motir auto` needs an agent to run.', {
      hint: 'Pass --agent "<cmd>", set MOTIR_AGENT, or configure agentCommand. `motir doctor` checks it.',
    });
  }
  return agent;
}

// ── the repo session registry ───────────────────────────────────────────────

/**
 * The session branch for the repo an item routes into, created on FIRST USE.
 *
 * Lazy on purpose: a run that never dispatches a `motir-ai` item must not leave
 * a stray branch in `motir-ai`. Keyed by resolved PATH rather than repo name, so
 * two names pointing at one checkout share one branch.
 *
 * Returns null when this target cannot carry a lineage — a BOOTSTRAP dispatch
 * (the checkout does not exist yet, so there is no repo to branch in) or an
 * UNPINNED item whose fallback root is not a git repository. Those items are
 * dispatched with no seed, which makes the server hand them the per-item-PR
 * prompt: the honest outcome, not a lineage the CLI could not actually create.
 */
class RepoSessions {
  private readonly byPath = new Map<string, RepoSession | null>();

  constructor(
    private readonly branch: string,
    private readonly run: CommandRunner,
  ) {}

  ensure(target: DispatchTarget): RepoSession | null {
    const existing = this.byPath.get(target.cwd);
    if (existing !== undefined) return existing;

    if (target.reason !== 'repo_checkout') {
      // No checkout to branch in (bootstrap), or an unpinned item at the root.
      // Try the root anyway — `motir link --repo .` makes it a real checkout —
      // but treat a git failure as "no lineage here", not as a run-ending error.
      const session = this.tryCreate(target, { tolerateFailure: true });
      this.byPath.set(target.cwd, session);
      return session;
    }
    const session = this.tryCreate(target, { tolerateFailure: false });
    this.byPath.set(target.cwd, session);
    return session;
  }

  private tryCreate(
    target: DispatchTarget,
    opts: { tolerateFailure: boolean },
  ): RepoSession | null {
    try {
      const outcome = ensureSessionBranchOnOrigin(target.cwd, this.branch, this.run);
      info(
        outcome === 'created'
          ? `Session branch ${this.branch} created on origin in ${target.cwd}.`
          : `Session branch ${this.branch} already on origin in ${target.cwd} — reusing it.`,
      );
      return { repoName: target.targetRepo, cwd: target.cwd, branch: this.branch, keys: [] };
    } catch (err) {
      if (!opts.tolerateFailure) throw err;
      info(
        `No session branch in ${target.cwd} (${err instanceof Error ? err.message : String(err)}).` +
          ' Items routed here ship as their own pull request.',
      );
      return null;
    }
  }

  /** Every repo a session branch was opened in, in first-touch order. A repo
   *  whose only item failed is included on purpose: its branch EXISTS on origin,
   *  and the summary saying so beats leaving a stray branch unmentioned. */
  touched(): RepoSession[] {
    return [...this.byPath.values()].filter((s): s is RepoSession => s !== null);
  }
}

// ── the command ─────────────────────────────────────────────────────────────

export async function autoCommand(opts: AutoOptions, deps: AutoDeps = {}): Promise<void> {
  const run = deps.run ?? execCommand;
  const clock = deps.clock ?? Date.now;
  const kinds = parseKinds(opts.kinds);
  const max = parseMax(opts.max);
  const agent = requireAgent(opts);
  const runId = runIdFromDate((deps.now ?? (() => new Date()))());
  const branch = sessionBranchName(runId);

  await withProjectSession(async (session) => {
    // ONE `whoami` for the whole run: the owner cannot change mid-loop, and an
    // unattended drain that asked per item would spend a request on a constant.
    const ownerId = await resolveOwnerId(session.client);
    const summary = await runAutoLoop({
      session,
      opts,
      kinds,
      max,
      agent,
      runId,
      branch,
      run,
      clock,
      runAgentFn: deps.runAgentFn ?? runAgent,
      ownerId,
    });
    closeOutRepos(summary, run);
    info('');
    info(renderAutoSummary(summary));
    process.exitCode = autoExitCode(summary);
  });
}

export interface LoopInput {
  session: ProjectSession;
  opts: AutoOptions;
  kinds: string[] | undefined;
  max: number | null;
  agent: ResolvedAgent;
  runId: string;
  branch: string;
  run: CommandRunner;
  clock: () => number;
  runAgentFn: typeof runAgent;
  /** The token owner — every card this run takes is CLAIMED for them, and rows
   *  claimed by anyone else are not taken at all (MOTIR-2427). */
  ownerId: string;
}

/** The WHILE loop itself. Exported so it can be driven end-to-end against a
 *  scripted client + agent, which is the only way the "re-queries every
 *  iteration" property can actually be asserted. */
export async function runAutoLoop(input: LoopInput): Promise<AutoSummary> {
  const { session, opts, kinds, max, agent, runId, branch, run, clock, runAgentFn, ownerId } =
    input;
  const { client, serverUrl, projectKey } = session;

  if (opts.reset) {
    const cleared = clearExcludes(serverUrl, projectKey);
    info(`Cleared ${cleared} excluded item${cleared === 1 ? '' : 's'}.`);
  }

  // Seeded from the PERSISTED list (items a previous session's agent failed on),
  // then grown in-process: an item skipped or failed this run must not be handed
  // straight back by the very next `next_ready`, or the loop would spin on it.
  // The PERSISTED list is keyed by KEY (MOTIR-2338); `next_ready` still narrows
  // by row ID. So the id set starts EMPTY and absorbs each excluded item's id
  // the first time the server hands it back — one extra round trip per
  // persisted exclusion, once, and the server keeps choosing.
  const excludedKeys = new Set(readExcludes(serverUrl, projectKey).map((e) => e.key.toUpperCase()));
  /** Every key this run has been handed — the termination guard below. */
  const seenKeys = new Set<string>();
  const records: DispatchRecord[] = [];
  const skipped: SkipRecord[] = [];
  const planning: PlanningRecord[] = [];
  const repos = new RepoSessions(branch, run);

  let interrupted = false;
  const onSigint = (): void => {
    if (interrupted) process.exit(130);
    interrupted = true;
    info('');
    info('Interrupt received — finishing up and opening the session pull request(s).');
    info('Press Ctrl-C again to exit immediately.');
  };
  process.on('SIGINT', onSigint);

  let stopReason: StopReason = 'drained';
  try {
    for (;;) {
      if (interrupted) {
        stopReason = 'interrupted';
        break;
      }
      if (max !== null && records.length >= max) {
        stopReason = 'max';
        break;
      }

      // ONE item, asked for fresh. Never a list — see the module header.
      // Held out by KEY: the client skips excluded rows inside the page walk,
      // so a previous run's failures cost no extra round trip (MOTIR-2398).
      // `ownerId` narrows the pick to what this run may take: unassigned rows,
      // and its own interrupted work. Both filters are CLIENT-SIDE — the ready
      // set has no status facet, and its `assigneeId` is single-valued, so
      // "unassigned OR mine" has no wire form — which is why the page walk that
      // backs this must follow the cursor rather than stop at a page it cannot
      // use (MOTIR-2427).
      const { item } = await client.nextReady({
        projectKey,
        ownerId,
        ...(kinds ? { kinds } : {}),
        ...(excludedKeys.size > 0 ? { excludeKeys: [...excludedKeys] } : {}),
      });
      if (!item) {
        stopReason = 'drained';
        break;
      }
      // ⚠️ TERMINATION. The loop asks again after every item, so a key it has
      // already taken coming back a second time means the ready set is not
      // shrinking — a status that did not move, or a server that disagrees with
      // this client about what is ready. Left alone the run spins forever
      // making requests, which is how an unattended command burns a night and a
      // quota. The old MCP enumeration had this guard for the same reason;
      // moving the pick client-side (MOTIR-2398) does not remove the need.
      if (seenKeys.has(item.key.toUpperCase())) {
        stopReason = 'halted';
        info('');
        info(
          `${item.key} was offered twice — the ready set is not advancing. Stopping rather than ` +
            "looping; check the item's status.",
        );
        break;
      }
      seenKeys.add(item.key.toUpperCase());

      const disposition = classifyReadyItem(item);
      if (disposition === 'needs_planning' && opts.includePlanning) {
        // TRIGGER, NEVER WAIT. Submit the expansion and go straight back to
        // `next_ready` — the job runs server-side and its output is a plan a
        // human must approve, so there is nothing here to wait FOR. The item
        // goes on the exclude list because it stays childless and would
        // otherwise be handed straight back on the very next iteration.
        planning.push(await triggerExpansion(client, serverUrl, item));
        excludedKeys.add(item.key.toUpperCase());
        continue;
      }
      if (disposition !== 'dispatch') {
        // Not dispatched, so NOT transitioned: a planning item and a human item
        // are both left exactly as the loop found them.
        skipped.push({ key: item.key, title: item.title, reason: disposition });
        excludedKeys.add(item.key.toUpperCase());
        info(
          `${item.key}: skipped — ${
            disposition === 'needs_planning'
              ? 'an unexpanded container needs planning'
              : 'human work'
          }.`,
        );
        continue;
      }

      // ⚠️ SEED FIRST, THEN RESOLVE (MOTIR-2398). The loop cannot resolve the
      // checkout before this read — `targetRepo` lives on the PROMPT, not on the
      // ready row (Amendment 10 Q2) — and cannot seed after it, because
      // `repos.ensure` creates the branch the seed names. So the seed goes out
      // first: the prompt is a pure READ that neither claims the item nor moves
      // its status, so asking before knowing whether a checkout exists costs
      // nothing and keeps the common path at ONE request.
      let dispatch = await client.dispatchPrompt(item.key, { sessionBranch: branch });
      const target = resolveDispatchTarget(
        session.link.dir,
        session.link.config,
        dispatch.targetRepo,
      );
      let repo: RepoSession | null;
      try {
        repo = repos.ensure(target);
      } catch (err) {
        // A git failure in a REAL checkout is a run-ending problem, and it
        // happens before any status flip — the item is untouched. Stop, but
        // still close out whatever earlier repos completed.
        info('');
        info(`${item.key}: ${err instanceof GitError ? err.message : String(err)}`);
        stopReason = 'halted';
        break;
      }

      if (!repo) {
        // No checkout to branch in, so the seeded prompt's lineage instruction
        // names a branch that does not exist here. Re-read WITHOUT the seed and
        // hand the agent the per-item-pull-request text instead. The extra
        // request buys correctness on a path that was already the exception.
        dispatch = await client.dispatchPrompt(item.key);
      }

      const record = await dispatchOne({
        client,
        item,
        dispatch,
        target,
        agent,
        clock,
        runAgentFn,
        ownerId,
        onIntegrated: (key) => repo?.keys.push(key),
      });
      records.push(record);

      if (record.outcome === 'failed') {
        addExclude(serverUrl, projectKey, { key: item.key });
        excludedKeys.add(item.key.toUpperCase());
        if (!opts.keepGoing) {
          stopReason = interrupted ? 'interrupted' : 'halted';
          break;
        }
      } else {
        removeExclude(serverUrl, projectKey, item.key);
        excludedKeys.delete(item.key.toUpperCase());
      }
    }
  } finally {
    process.off('SIGINT', onSigint);
  }

  return { runId, records, skipped, planning, repos: repos.touched(), prs: [], stopReason };
}

/**
 * Fire ONE expansion and record how the submit went. Never throws.
 *
 * A failed expansion is NON-halting, unlike a failed agent: nothing else in the
 * run depends on it (its output could not have joined this run anyway — it needs
 * a human's approval first), so the honest response is to name the item and keep
 * dispatching. That asymmetry is the reason this swallows the error here rather
 * than letting the loop's failure policy see it.
 */
async function triggerExpansion(
  client: MotirClient,
  serverUrl: string,
  item: DispatchItem,
): Promise<PlanningRecord> {
  const base = { key: item.key, title: item.title };
  try {
    const { planId, jobId } = await client.expandItem(item.key);
    const reviewUrl = planReviewUrl(serverUrl, planId);
    info(
      `${item.key}: planning triggered — job ${jobId}, plan ${planId}. ` +
        'It produces PROPOSALS awaiting your approval; the loop moves on.',
    );
    return { ...base, outcome: 'triggered', planId, reviewUrl };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    info(`${item.key}: planning FAILED — ${detail}. Left unexpanded; the loop continues.`);
    return { ...base, outcome: 'failed', planId: null, reviewUrl: null, detail };
  }
}

interface DispatchOneInput {
  client: MotirClient;
  item: DispatchItem;
  /** Read by the CALLER, before the checkout was resolved — see the seed-first
   *  note there. Passed in so this function makes no second prompt request. */
  dispatch: DispatchPrompt;
  target: DispatchTarget;
  agent: ResolvedAgent;
  clock: () => number;
  runAgentFn: typeof runAgent;
  onIntegrated: (key: string) => void;
  /** Claimed for this owner before the agent launches (MOTIR-2427). */
  ownerId: string;
}

/** Run ONE item through the single-dispatch pipeline and record how it ended. */
async function dispatchOne(input: DispatchOneInput): Promise<DispatchRecord> {
  const { client, item, dispatch, target, agent, clock, runAgentFn, onIntegrated, ownerId } = input;

  await ensureInProgress(client, item.key, item.status?.key, ownerId);

  info('');
  info(`── ${item.key} — ${item.title}`);
  info(`   ${target.cwd}  (${cwdReasonLabel(target)})`);
  info(
    dispatch.sessionBranch
      ? `   integrating into ${dispatch.sessionBranch}`
      : '   no session lineage — this item ships as its own pull request',
  );

  const started = clock();
  const result = await runAgentFn({
    command: agent.parsed,
    prompt: dispatch.prompt,
    cwd: target.cwd,
  });
  const durationMs = clock() - started;

  const base = {
    key: item.key,
    title: item.title,
    durationMs,
    repo: dispatch.targetRepo,
    // Off the prompt the loop already fetched — no extra request (MOTIR-2445).
    parentKey: dispatch.parentKey,
  };

  if (result.exitCode !== 0) {
    info(`${item.key}: agent exited ${result.exitCode} — left In Progress, nothing reverted.`);
    return {
      ...base,
      outcome: 'failed',
      sessionBranch: null,
      detail: result.signal ? `killed by ${result.signal}` : `exit ${result.exitCode}`,
    };
  }

  // A bootstrap dispatch that did not produce its checkout is a FAILED dispatch,
  // not a success with a warning: the prompt's whole job was to create it, and
  // every later item routed at that repo would repeat the same bootstrap.
  const suspect = checkBootstrapCheckout(target);
  if (suspect) {
    info(`${item.key}: ${suspect.message}`);
    info(`Hint: ${suspect.hint}`);
    return {
      ...base,
      outcome: 'failed',
      sessionBranch: null,
      detail: 'bootstrap checkout missing',
    };
  }

  if (dispatch.workflowMode === 'session_lineage' && dispatch.sessionBranch) {
    await client.markIntegrated({
      key: item.key,
      sessionBranch: dispatch.sessionBranch,
      // The provenance triple, split by WHO KNOWS (MOTIR-2419): the harness is
      // derived from the command this loop launched, the model comes from the
      // agent's own report and is null when it made none.
      implementationHarness: deriveAgentHarness(agent.parsed.binary),
      implementationModel: result.model,
    });
    onIntegrated(item.key);
    info(`${item.key}: integrated on ${dispatch.sessionBranch} in ${formatDuration(durationMs)}.`);
    return { ...base, outcome: 'integrated', sessionBranch: dispatch.sessionBranch };
  }

  // The server kept this item off the session lineage — a target with no repo
  // checkout to branch in. Its prompt told the agent to open a pull request of
  // its own, so In Review is the truthful status.
  await client.transitionStatus({ key: item.key, status: 'in_review' });
  info(`${item.key}: In Review via its own pull request in ${formatDuration(durationMs)}.`);
  return { ...base, outcome: 'in_review', sessionBranch: null, detail: 'own pull request' };
}

// ── the end-of-run close-out ────────────────────────────────────────────────

/**
 * Push each touched session branch and open ONE pull request per repo.
 *
 * Runs on EVERY exit path — drained, `--max`, a halt, Ctrl-C — because a run
 * that integrated three items and then hit a failure must not abandon those
 * three. This is the loop's only human gate: main has none of this work until
 * somebody merges these.
 */
export function closeOutRepos(summary: AutoSummary, run: CommandRunner): void {
  for (const repo of summary.repos) {
    const report = closeOutRepo(summary, repo, run);
    summary.prs.push(report);
  }
}

function closeOutRepo(summary: AutoSummary, repo: RepoSession, run: CommandRunner): PrReport {
  const base = { repoName: repo.repoName, branch: repo.branch };
  try {
    // Normally a no-op: the prompt already had the agent push. This catches the
    // agent that integrated locally and stopped.
    const pushed = pushSessionBranchIfAhead(repo.cwd, repo.branch, run);
    if (pushed === 'pushed') info(`Pushed ${repo.branch} in ${repo.cwd}.`);

    if (!sessionBranchHasCommits(repo.cwd, repo.branch, run)) {
      return { ...base, url: null, outcome: 'empty' };
    }
    // Only THIS repo's items belong in THIS repo's pull request: the branch
    // carries the ones integrated onto it, and the failures listed alongside are
    // the ones that were attempted in the same repo.
    const mine = summary.records.filter(
      (r) =>
        r.sessionBranch === repo.branch || (r.outcome === 'failed' && r.repo === repo.repoName),
    );
    const carried = mine.filter((r) => r.outcome !== 'failed');
    const result = openSessionPr(
      repo.cwd,
      {
        branch: repo.branch,
        title: sessionPrTitle(summary.runId, carried),
        // The agents' own commit messages, read from THIS repo's checkout
        // against THIS repo's branch — a multi-repo run must not put another
        // repo's commits in this body (MOTIR-2411).
        body: renderSessionPrBody(
          summary.runId,
          repo.branch,
          mine,
          sessionBranchCommits(repo.cwd, repo.branch, run),
        ),
      },
      run,
    );
    return {
      ...base,
      url: result.url,
      outcome: result.outcome,
      ...(result.message ? { message: result.message } : {}),
    };
  } catch (err) {
    return {
      ...base,
      url: null,
      outcome: 'failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
