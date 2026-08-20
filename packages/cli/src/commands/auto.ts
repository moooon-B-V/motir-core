import { CliError, PlanNotDecidableError } from '../errors.js';
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
  agentSubmittedReplan,
  checkBootstrapCheckout,
  contradictoryReplanFlags,
  cwdReasonLabel,
  findingsPolicyOf,
  renderFindingsPolicy,
  renderReplanSubmitted,
  renderRepositoriesBlock,
  resolveDispatchTarget,
  resolveDispatchTargets,
  type DispatchTarget,
} from '../dispatch.js';
import {
  autoExitCode,
  classifyReadyItem,
  formatDuration,
  landedWork,
  planReviewUrl,
  renderAutoSummary,
  renderSessionPrBody,
  sessionPrTitle,
  type ApprovalRecord,
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
  workReachedRemote,
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
  /**
   * `--auto-approve-replan` — approve a re-plan the agent submitted and KEEP
   * LOOPING, instead of stopping for a human (MOTIR-3022).
   *
   * ⚠️ `auto` ONLY, and the reason is the mechanism rather than taste: this is
   * the one command that re-asks `next_ready` each iteration, so a
   * newly-approved card genuinely enters the run. `run` / `next` exit after one
   * item and `batch` froze its list before starting; all three REGISTER the flag
   * in order to refuse it with that reason.
   *
   * This card registers, validates and passes it through. What the loop DOES
   * with it is MOTIR-3023.
   */
  autoApproveReplan?: boolean;
}

/** Injectable seams; never overridden in production. */
export interface AutoDeps {
  run?: CommandRunner;
  now?: () => Date;
  clock?: () => number;
  /** The agent launcher. Injected by the tests so the loop can be driven with a
   *  scripted agent — the fixture the acceptance criteria are written against. */
  runAgentFn?: typeof runAgent;
  /** The wait between approval retries while a planner is still writing
   *  (MOTIR-3025). Injected so a test can prove the RETRY without spending a
   *  real minute on it; never overridden in production. */
  sleep?: (ms: number) => Promise<void>;
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

  /**
   * The session(s) an item's whole repository SET routes into (MOTIR-3135).
   *
   * ⚠️ ALL-OR-NOTHING per card, and that is the decision this method carries. A
   * lineage in SOME of a card's repositories and not others is the one outcome
   * that cannot be closed out: `closeOutRepos` opens a pull request per TOUCHED
   * repository, so a repository holding the work but not the branch is invisible
   * to it — the work sits on a local branch nothing will ever push or review. So
   * if any repository of the card cannot carry the lineage, the CARD gets none,
   * and the server hands it the per-item-pull-request prompt for all of them.
   *
   * For a multi-repository card the un-carryable case is settled BEFORE any
   * branch is created, so a card that falls back leaves no stray branch behind
   * in the repositories that could have carried it.
   *
   * Returns `null` when this card gets no seed.
   */
  ensure(targets: readonly DispatchTarget[]): RepoSession[] | null {
    if (targets.length <= 1) {
      const single = this.ensureOne(targets[0]!);
      return single === null ? null : [single];
    }
    // The cheap pass first: a target with no checkout to branch in, or one an
    // earlier item already found un-carryable, decides this without touching git.
    for (const target of targets) {
      const cached = this.byPath.get(target.cwd);
      if (cached === null || (cached === undefined && target.reason !== 'repo_checkout')) {
        info(
          `No session branch possible in ${target.cwd} (${target.targetRepo ?? 'unpinned'}).` +
            ' This card carries more than one repository, so it ships as its own pull' +
            ' requests in all of them rather than a lineage in some.',
        );
        return null;
      }
    }
    // Every element is a real checkout: create or reuse, and a git failure in one
    // of them is the same run-ending problem it is for a single-repository card.
    return targets.map((target) => this.ensureOne(target)!);
  }

  private ensureOne(target: DispatchTarget): RepoSession | null {
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
  // ⚠️ CONTRADICTORY FLAGS ARE REFUSED, not resolved by precedence (MOTIR-3022).
  // `--auto-approve-replan` with `--disable-replan` says approve a submission the
  // agent was told not to make; honouring either one silently leaves the operator
  // believing the other. Refused BEFORE the agent is resolved, so nothing is
  // claimed for a run that cannot mean what it says.
  if (opts.autoApproveReplan) {
    const contradiction = contradictoryReplanFlags(opts);
    if (contradiction) {
      throw new CliError(contradiction, {
        hint: 'Drop one: `--auto-approve-replan` to keep the agent from re-planning at all, or `--disable-replan` to approve what it submits.',
      });
    }
  }
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
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    });
    closeOutRepos(summary, run);
    info('');
    info(renderAutoSummary(summary));
    info(renderFindingsPolicy(opts));
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
  /** The approval-retry wait (MOTIR-3025), injected by the tests. */
  sleep?: (ms: number) => Promise<void>;
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
  /** What `--auto-approve-replan` approved (MOTIR-3023). */
  const approvals: ApprovalRecord[] = [];
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
      let dispatch = await client.dispatchPrompt(item.key, {
        sessionBranch: branch,
        findingsPolicy: findingsPolicyOf(opts),
      });
      // One target per repository the card ships in (MOTIR-3133), primary first.
      // An older server sends no set, and the empty array falls back to the
      // single-repository resolve — exactly the shape this loop had before.
      const targets = resolveDispatchTargets(
        session.link.dir,
        session.link.config,
        (dispatch.targetRepos ?? []).map((r) => r.name),
      );
      const resolved =
        targets.length > 0
          ? targets
          : [resolveDispatchTarget(session.link.dir, session.link.config, dispatch.targetRepo)];
      const target = resolved[0]!;
      let repo: RepoSession[] | null;
      try {
        repo = repos.ensure(resolved);
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
        dispatch = await client.dispatchPrompt(item.key, {
          findingsPolicy: findingsPolicyOf(opts),
        });
      }

      const record = await dispatchOne({
        client,
        item,
        dispatch,
        target,
        targets: resolved,
        repos: resolved.map((t) => t.targetRepo).filter((n): n is string => n !== null),
        agent,
        clock,
        runAgentFn,
        ownerId,
        run,
        // The card is integrated in EVERY repository of its lineage, so it is
        // carried by every one of their pull requests (MOTIR-3135).
        onIntegrated: (key) => repo?.forEach((s) => s.keys.push(key)),
      });
      records.push(record);

      // ⚠️ A REFUSED CARD STOPS THE RUN, and `--keep-going` does not override it
      // (MOTIR-3018). That flag says "one agent failing is not a reason to
      // abandon the rest"; this is not a failure — it is the agent reporting
      // that the PLAN is wrong, and the cards the loop would take next are the
      // ones the submitted plan may be about to change. The prompt's own branch
      // tells the agent not to pick up other work; the loop honours the same
      // instruction.
      //
      // ⚠️ UNLESS THE OPERATOR SAID OTHERWISE (MOTIR-3023). With
      // `--auto-approve-replan` the run approves the plan the card produced and
      // CONTINUES — which is the whole value of the flag: an overnight sweep of
      // twenty cards should not end at card three because one premise was stale.
      if (record.outcome === 'replanned') {
        if (!opts.autoApproveReplan) {
          stopReason = 'replanned';
          break;
        }
        // ⚠️ HELD OUT FIRST, BEFORE the approval — and this is the guard that
        // costs real money if it is missed. Approve → the card returns to the
        // ready set → dispatched again → refused again → another submit, and
        // every submit spends the token owner's AI credits. The exclusion goes
        // in whether or not the approval succeeds, because a card that refused
        // itself once will refuse itself again.
        addExclude(serverUrl, projectKey, { key: item.key });
        excludedKeys.add(item.key.toUpperCase());

        const approved = await approveSubmittedPlan(client, item.key, {
          ...(input.sleep ? { sleep: input.sleep } : {}),
        });
        if (!approved.ok) {
          // ⚠️ A REFUSED APPROVAL STOPS THE RUN, with the SERVER's own message.
          // Continuing would dispatch against a tree the operator has not agreed
          // to — and the server's refusals are exactly the bounds that say so
          // (no plan of this card's own, a plan already decided, a scope the
          // token lacks). None of them is a reason to carry on regardless.
          info('');
          info(`${item.key}: the re-plan could NOT be approved — ${approved.message}`);
          info('Stopping rather than continuing against a tree nobody approved.');
          stopReason = 'replanned';
          break;
        }
        approvals.push({ key: item.key, ...approved.plan });
        info(
          `${item.key}: its re-plan was APPROVED (plan ${approved.plan.planId}, ` +
            `${approved.plan.proposalCount} proposal(s) materialized). Continuing.`,
        );
        continue;
      }

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

  return {
    runId,
    records,
    skipped,
    planning,
    repos: repos.touched(),
    prs: [],
    approvals,
    stopReason,
  };
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
  /** Every repository the card ships in, primary first (MOTIR-3135) — recorded
   *  so a FAILED card reaches every repository's session pull request. */
  repos: string[];
  /** The RESOLVED targets behind {@link DispatchOneInput.repos}, so the loop's
   *  per-item output names every checkout the card will be worked in. */
  targets: DispatchTarget[];
  agent: ResolvedAgent;
  clock: () => number;
  runAgentFn: typeof runAgent;
  onIntegrated: (key: string) => void;
  /** Claimed for this owner before the agent launches (MOTIR-2427). */
  ownerId: string;
  /** The loop's git runner — the push check (MOTIR-3004) uses it. */
  run: CommandRunner;
}

/**
 * How long the loop will wait for a planner to finish writing a submitted plan
 * before giving up on approving it (MOTIR-3025).
 *
 * ⚠️ BOUNDED, and the bound is the decision. An unattended run must not block on
 * a planner indefinitely — that is the reason the agent submits with `--detach`
 * in the first place — but it must not give up in the first hundred
 * milliseconds either, because that is where the plan almost always is when the
 * agent exits. Roughly a minute of patience, then the run reports precisely what
 * it was waiting for and stops.
 */
const APPROVE_ATTEMPTS = Number(process.env['MOTIR_APPROVE_ATTEMPTS'] ?? '') || 12;
const APPROVE_WAIT_MS = Number(process.env['MOTIR_APPROVE_WAIT_MS'] ?? '') || 5_000;

/** Run ONE item through the single-dispatch pipeline and record how it ended. */
async function dispatchOne(input: DispatchOneInput): Promise<DispatchRecord> {
  const { client, item, dispatch, target, agent, clock, runAgentFn, onIntegrated, ownerId, run } =
    input;

  await ensureInProgress(client, item.key, item.status?.key, ownerId);

  info('');
  info(`── ${item.key} — ${item.title}`);
  info(`   ${target.cwd}  (${cwdReasonLabel(target)})`);
  // Every OTHER repository the card ships in, from the same renderer `run` /
  // `next` / `batch` use (MOTIR-3133) — nothing at all for a one-repository card.
  for (const line of renderRepositoriesBlock(input.targets)) info(`   ${line.trimStart()}`);
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
    // The whole set, so a FAILED record reaches the pull-request body of every
    // repository it half-touched, not only the primary's (MOTIR-3135).
    repos: input.repos,
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

  // ⚠️ EXIT 0 IS NOT AN OUTCOME (MOTIR-3018). A finished card and a REFUSED one
  // both exit 0, so ask the card which it was before deciding anything else.
  // FIRST, ahead of the bootstrap and push checks, because a refusing agent
  // reverts its worktree and pushes nothing BY DESIGN — those checks would
  // otherwise report a correctly-refused card as a failed bootstrap or as work
  // that went missing.
  if (await agentSubmittedReplan(client, item.key)) {
    info('');
    info(renderReplanSubmitted(item.key));
    // `sessionBranch: null` is the substantive claim here, not bookkeeping: the
    // card was never integrated, so it must not appear among the cards the
    // branch carries or in the pull request this run opens.
    return { ...base, outcome: 'replanned', sessionBranch: null };
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
  // its own, so Implemented is the truthful status: built, pushed, waiting on CI.
  //
  // ⚠️ EXIT 0 IS NOT A PUSH (MOTIR-3004) — checked here for the same reason the
  // single-item path checks it, and with the loop's own git runner.
  if (workReachedRemote(target.cwd, item.key, null, run) === 'nothing') {
    info(`${item.key}: agent exited 0 but nothing reached the remote — left In Progress.`);
    return {
      ...base,
      outcome: 'failed',
      sessionBranch: null,
      detail: 'nothing reached the remote',
    };
  }
  await client.transitionStatus({ key: item.key, status: 'implemented' });
  info(
    `${item.key}: Implemented via its own pull request in ${formatDuration(durationMs)} — CI decides when it is reviewable.`,
  );
  return { ...base, outcome: 'implemented', sessionBranch: null, detail: 'own pull request' };
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
        r.sessionBranch === repo.branch ||
        // A failed card belongs in the body of EVERY repository it was attempted
        // in, not only its primary (MOTIR-3135). `repos` is absent on records
        // written before it existed, and the scalar is that record's whole set.
        (r.outcome === 'failed' && (r.repos ?? [r.repo]).includes(repo.repoName)),
    );
    const carried = mine.filter(landedWork);
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

/**
 * Approve the plan a refused card produced. NEVER THROWS.
 *
 * ⚠️ THE REFUSALS ARE THE INTERESTING RETURN VALUE, which is why this reports
 * rather than raises. Every one of them is a BOUND the server is enforcing —
 * there is no plan of this card's own, the plan was already decided, the token
 * lacks `ai:view_plan` — and each means the same thing to the loop: it must not
 * carry on against a tree nobody approved. Letting the error propagate would
 * take the run's close-out down with it (the shape MOTIR-3018's reproduction
 * found), abandoning work that has nothing to do with this plan.
 *
 * ⚠️ IT SENDS NO PLAN ID, and cannot. The plan was submitted by the AGENT, in a
 * sandbox, with `motir plan --detach <KEY>`; its id came back on that agent's
 * stdout, which this process streams straight to the terminal and never
 * captures. The card IS the address, and the server derives the plan from the
 * conversation anchored at it — so the run cannot approve a plan the card did
 * not produce even by mistake.
 */
async function approveSubmittedPlan(
  client: MotirClient,
  key: string,
  opts: { attempts?: number; waitMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<
  { ok: true; plan: { planId: string; proposalCount: number } } | { ok: false; message: string }
> {
  const attempts = opts.attempts ?? APPROVE_ATTEMPTS;
  const waitMs = opts.waitMs ?? APPROVE_WAIT_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (let attempt = 1; ; attempt += 1) {
    try {
      return { ok: true, plan: await client.approveWorkItemPlan(key) };
    } catch (err) {
      // ⚠️ `generating` IS "NOT YET", AND WAITING IS THE POINT. The agent
      // submitted with `--detach` — it must not sit on a planner — and exited
      // within milliseconds, so the loop routinely arrives while motir-ai is
      // still writing the plan. Treating that as a refusal would make the flag
      // useless in exactly its normal case; treating a DECIDED plan the same way
      // would keep retrying something a person already answered. The server
      // tells the two apart as data, which is why this branches on the field.
      const notYet = err instanceof PlanNotDecidableError && err.planStatus === 'generating';
      if (notYet && attempt < attempts) {
        if (attempt === 1) {
          info(`${key}: its plan is still being written — waiting for the planner.`);
        }
        await sleep(waitMs);
        continue;
      }
      // The SERVER's own sentence, verbatim. A message this loop composed would
      // describe the refusal it guessed at rather than the one it received.
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        message: notYet
          ? `${message} (still generating after ${attempts} attempts — approve it in Motir once the planner finishes)`
          : message,
      };
    }
  }
}
