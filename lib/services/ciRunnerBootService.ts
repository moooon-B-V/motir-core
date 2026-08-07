import type { CiRunnerProvisioningIntent } from '@/generated/prisma/client';
import { withSystemContext } from '@/lib/workspaces/context';
import {
  ciRunnerProvisioningIntentRepository as intents,
  CI_RUNNER_INTENT_COMPLETED,
  CI_RUNNER_INTENT_FAILED,
} from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import {
  ciRunnerAdmissionService,
  type AdmissionDeferralReason,
} from '@/lib/services/ciRunnerAdmissionService';
import {
  projectRunnerGroupService,
  RunnerGroupNotProvisionedError,
} from '@/lib/services/projectRunnerGroupService';
import {
  runnerJitConfigClient,
  RunnerJitTimeoutError,
  RunnerRegistrationRateLimitedError,
  RUNNER_JIT_REQUEST_TIMEOUT_MS,
} from '@/lib/github/runnerJitConfig';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import type { FleetWorkloadKind } from '@/lib/ciFleet/workloads';
import {
  getOrchestrator,
  isOrchestratorConfigured,
  OrchestratorImageUnpullableError,
  ORCHESTRATOR_REQUEST_TIMEOUT_MS,
} from '@/lib/orchestrator';
import { flyFleetConfig } from '@/lib/orchestrator/adapters/fly/flyMachines';
import { FLEET_CONTAINER_SIZE } from '@/lib/orchestrator/rates';
import { recordContainerUsage } from '@/lib/orchestrator/usageSink';
import type {
  ContainerHandle,
  ContainerOrchestrator,
  ContainerSpec,
  ContainerUsage,
  TeardownReason,
  UsageAttribution,
} from '@/lib/orchestrator/types';

// THE PROVISIONER (Story MOTIR-1916 · MOTIR-1921) — one provisioning intent
// becomes exactly one single-use ephemeral runner, and is guaranteed to stop
// costing money afterwards.
//
// `docs/decisions/ci-runner-fleet.md` §10 scopes this card: the port, the Fly
// adapter, the fake adapter, `reap()` and its schedule. This service is what
// drives them.
//
// ⚠️ TEARDOWN IS THE CORRECTNESS PROPERTY, NOT BOOT. Boot failing is visible and
// cheap — a job queues and someone notices. Teardown failing is invisible and
// bills forever. So the shape of this file is deliberately lopsided: the boot is
// a handful of straight-line calls, and everything else is the four independent
// mechanisms that make sure nothing survives it.
//
//   1. The JIT CONFIG — the runner takes exactly one job, de-registers, exits.
//   2. `auto_destroy: true` + `restart: { policy: 'no' }` in the Fly adapter — an
//      exiting process is a destroyed machine, not a restarted one.
//   3. THE POLL LOOP CANNOT EXIT EXCEPT INTO {@link ciRunnerBootService.settleSupervision}
//      — every path out of supervision tears the container down, including the
//      ones that failed. See the note below on what changed here (MOTIR-2007).
//   4. {@link ciRunnerBootService.reapOrphans} — the backstop for the ONE case
//      guarantee 3 cannot cover: the supervisor dying between provision and
//      teardown.
//
// They are independent on purpose. Any one of them can fail without leaking a
// container, which is the only useful definition of "guaranteed" for something
// whose failure is silent.
//
// ⚠️ GUARANTEE 3 USED TO BE A `finally`, AND A `finally` COULD NOT HOLD IT
// (MOTIR-2007). Supervision watches a container for up to {@link
// DEFAULT_JOB_TIMEOUT_MS} = 3,600s. It used to do that synchronously, inside ONE
// serverless invocation, whose ceiling is `maxDuration = 300` in
// `app/api/inngest/route.ts` — twelve times shorter. So every CI job longer than
// ~5 minutes had its supervisor killed mid-loop with `FUNCTION_INVOCATION_TIMEOUT`:
// the `finally` never ran, the intent stayed `running` and held a fleet slot
// against BOTH the per-project cap and the fail-CLOSED cross-workload ceiling
// until the reaper aged it out 70 minutes later, the run dead-lettered while the
// job had actually succeeded, and the container's cost was recorded late and
// coarsely or not at all. A spend guard turning into an outage.
//
// The fix is the SHAPE, not another patch: supervision is now a DURABLE POLL
// LOOP owned by the job (`lib/jobs/definitions/ciRunnerFleet.ts`). This service
// exposes the three individually-BOUNDED operations it drives —
// {@link ciRunnerBootService.bootIntent}, {@link ciRunnerBootService.pollOnce},
// {@link ciRunnerBootService.settleSupervision} — each of which does a fixed,
// small amount of work and returns. The job wraps each in its own `ctx.step.run`
// and waits between polls with `ctx.step.sleep`, so no STEP ever approaches
// `maxDuration` while the RUN spans an hour across many invocations. That is
// what Inngest's durable execution is for, and `docs/jobs.md` rule 1 is the rule
// this file used to be the one documented exception to.
//
// ⚠️ WHICH IS WHY {@link ciRunnerBootService.pollOnce} MUST NEVER THROW. In a
// stepped world there is no process holding a `finally`, and a step that fails
// terminally is NOT followed by a step scheduled from a catch — the executor
// finalizes the run as failed first (`PRODECT_FINDINGS` #39, the trap that made
// `defineJob` move its dead-letter write to `onFailure`). So teardown cannot be
// reached from a catch. Guarantee 3 is instead structural: `pollOnce` converts
// every failure it can meet into a TYPED result, so the only way out of the loop
// is a `done` verdict, and a `done` verdict goes to `settleSupervision`.
//
// ⚠️ WHO DECIDES WHETHER THIS RUNS AT ALL. §10 puts the ADMISSION GATE — the
// per-project in-flight cap, the fleet-wide ceiling and the
// `ci_credits_exhausted` refusal — in MOTIR-1922, "consulted BEFORE this card
// provisions". It has landed as `ciRunnerAdmissionService`, and {@link
// ciRunnerBootService.runIntent} consults it EXACTLY WHERE THE CLAIM USED TO BE:
// the gate decides and claims in one locked transaction, because the claim is
// what makes an intent count as in-flight and a gate that did not own it would be
// deciding from a count that excludes the decisions already made. This service
// still reads no cap, no ceiling and no balance itself — it asks, and it obeys.
//
// The pending-intent sweep below remains the trigger. It is honest but slow (a
// minute-granularity cron cannot meet §6's ≤30s p50 budget); a hot-path call from
// the `workflow_job` webhook straight to this service is the remaining half of
// that budget and is tracked as its own card.

/**
 * WHAT THIS SERVICE BOOTS (MOTIR-2025). The orchestrator port carries a workload
 * now, and this is the only producer of a `ci_runner` one — index and agent
 * containers are dispatched by their own services onto the same port.
 *
 * Named once rather than repeated at the four sites that need it, so a reader
 * asking "does this service ever boot anything else?" gets the answer from one
 * grep instead of four string literals.
 */
const CI_RUNNER_WORKLOAD = 'ci_runner' satisfies FleetWorkloadKind;

/** How long a container has to reach a running state before it is written off as
 *  a boot that never happened. §6 budgets p95 ≤ 60s end to end; double that is a
 *  deadline that cannot fire on a merely-slow boot. */
const DEFAULT_BOOT_DEADLINE_MS = 120_000;

/** The hard kill. GitHub's own ceiling is a 5-day job; a CI job that has not
 *  finished in an hour on 2-core hardware is not going to, and every further
 *  second is billed to Motir. §11 leaves what happens to the JOB (re-queue,
 *  surface, leave it to the user's re-run) to the fleet's operational story; what
 *  is fixed here is that the CONTAINER stops. */
const DEFAULT_JOB_TIMEOUT_MS = 3_600_000;

/** How soon after boot supervision first asks the provider what the container is
 *  doing. Short, because a fast job should settle fast: the sooner a terminal
 *  container is observed, the sooner it is torn down and metered. */
const DEFAULT_POLL_INTERVAL_MS = 3_000;

/**
 * The ceiling the poll interval backs off to.
 *
 * ⚠️ THIS EXISTS BECAUSE THE WAIT IS NOW A STEP. A fixed 3s interval across a
 * 3,600s job is 1,200 `step.sleep` + `step.run` pairs — 2,400 steps for ONE CI
 * job, each a checkpoint Inngest persists and re-invokes through. Backing off to
 * {@link MAX_POLL_INTERVAL_MS} makes a full-length job ~125 polls instead, and
 * costs only DETECTION latency: the container is destroyed by `auto_destroy`
 * when the runner exits either way, so a later observation delays the teardown
 * call and the usage row, not the machine stopping.
 *
 * Kept well under {@link DEFAULT_BOOT_DEADLINE_MS} so the boot deadline is still
 * observed with granularity rather than overshot by a whole interval.
 */
const MAX_POLL_INTERVAL_MS = 30_000;

/** How much the poll interval grows each time it is not yet terminal, until it
 *  reaches {@link MAX_POLL_INTERVAL_MS}. */
const POLL_BACKOFF_FACTOR = 2;

/**
 * A hard ceiling on poll iterations, independent of the clock.
 *
 * {@link pollOnce} already terminates on {@link DEFAULT_JOB_TIMEOUT_MS}, so this
 * is not the bound that matters — it is the bound that still holds if the clock
 * does something surprising (a frozen `now`, a test seam, a provider that never
 * reports terminal). A durable loop with no static bound is a runaway that bills
 * per iteration, so it gets one.
 */
const MAX_POLL_ITERATIONS = 2_000;

/**
 * How many CONSECUTIVE provider status reads may fail before supervision gives
 * up and tears the container down.
 *
 * Not zero, because a single 500 from the provider would otherwise end a
 * customer's healthy CI run for a reason that has nothing to do with their code.
 * Not unbounded, because a provider that is genuinely unreachable must not leave
 * this loop watching a container forever — and the deadlines still bound it
 * either way, since a failed read falls through to the same checks.
 */
const MAX_CONSECUTIVE_READ_FAILURES = 3;

/** How long a claimed-but-never-booted intent may sit before the sweep writes it
 *  off and de-registers its runner. Comfortably past the boot deadline, so a
 *  slow-but-live provision is never swept out from under itself. */
const STALE_CLAIM_MS = 15 * 60_000;

/** How old a container must be before the reaper destroys it. Past the job
 *  timeout, so the reaper only ever sees containers supervision genuinely failed
 *  to reach — not ones it is about to. */
const DEFAULT_REAP_AFTER_MS = DEFAULT_JOB_TIMEOUT_MS + 10 * 60_000;

/**
 * THE FLEET'S TIME BUDGETS, AND HOW THEY RELATE TO THE PLATFORM CEILING — stated
 * ONCE, here, and asserted in `tests/ciFleet/fleetTimeBudgets.test.ts`
 * (MOTIR-2007). `docs/jobs.md` rule 2 asks for exactly this inequality; the fleet
 * was the case it did not hold for.
 *
 * Read `maxDuration` (300s, `app/api/inngest/route.ts`) as the ceiling on ONE
 * INVOCATION — i.e. on one step — never on a run. Then:
 *
 *   • `stepWorkBudgetMs` ≤ maxDuration · 1000
 *        The bound on what any ONE step of the boot path does. `pollOnce` is one
 *        provider read; `settleSupervision` is a teardown plus its bookkeeping.
 *        This is the constraint that regressed into an hour-long step before.
 *
 *   • `jobTimeoutMs` > maxDuration · 1000        ← DELIBERATE, and only safe now
 *        A supervised CI job may run 3,600s, twelve times the invocation ceiling.
 *        That is legal ONLY because the RUN is stepped: no single step spans it.
 *        Shortening this to fit inside one invocation was the tempting non-fix —
 *        it caps every tenant's CI job at five minutes, which is the product
 *        regressing to fit the bug.
 *
 *   • `pollIntervalMs` ≤ `maxPollIntervalMs` < `bootDeadlineMs` < `jobTimeoutMs`
 *        The boot deadline must be observable at poll granularity, and it must be
 *        able to fire before the job timeout does.
 *
 *   • `reapAfterMs` > `jobTimeoutMs`
 *        The reaper stays the BACKSTOP: it may only ever see containers
 *        supervision has already given up on, never ones it is about to settle.
 *
 *   • `mintDeadlineMs` + `containerCallDeadlineMs` ≤ `stepWorkBudgetMs`
 *        RULE 3's inequality, for the one path that did not hold it (MOTIR-2011).
 *        Rule 2 bounds the SHAPE of a step; this bounds its CLOCK. The boot step
 *        makes exactly two external calls — mint, then provision — and their
 *        deadlines are what turn "this step does one small thing" from a claim
 *        about the code into a bound on its wall time. They are IMPORTED from
 *        the two clients rather than restated, so a client that lengthens its
 *        deadline has to come past the assertion.
 *
 * Change one of these and the assertion makes you look at the others.
 */
export const FLEET_TIME_BUDGETS = {
  bootDeadlineMs: DEFAULT_BOOT_DEADLINE_MS,
  jobTimeoutMs: DEFAULT_JOB_TIMEOUT_MS,
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  maxPollIntervalMs: MAX_POLL_INTERVAL_MS,
  reapAfterMs: DEFAULT_REAP_AFTER_MS,
  maxPollIterations: MAX_POLL_ITERATIONS,
  /**
   * What ONE step of the boot path is allowed to spend. Not a timer this code
   * enforces — a budget the steps are SHAPED to respect (one provider call each)
   * and which the test asserts against the route's `maxDuration`.
   */
  stepWorkBudgetMs: 120_000,
  /** The GitHub `generate-jitconfig` deadline — the boot step's first call. */
  mintDeadlineMs: RUNNER_JIT_REQUEST_TIMEOUT_MS,
  /** The container provider's per-call deadline — the boot step's second call,
   *  and the only call a poll or a teardown step makes. */
  containerCallDeadlineMs: ORCHESTRATOR_REQUEST_TIMEOUT_MS,
} as const;

/**
 * How long to wait before poll number `iteration` (1-based).
 *
 * PURE, and deliberately a function of the iteration rather than of the clock:
 * the durable loop re-derives it on every replay pass, so a wall-clock input
 * would make two passes of the same run schedule different sleeps.
 */
export function pollWaitMs(iteration: number, options: SupervisionOptions = {}): number {
  const base = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const cap = options.maxPollIntervalMs ?? MAX_POLL_INTERVAL_MS;
  const grown = base * POLL_BACKOFF_FACTOR ** Math.max(0, iteration - 1);
  return Math.min(Math.max(base, grown), Math.max(base, cap));
}

/** Seams the tests drive. Defaults are the constants above; nothing else may
 *  pass them, which is why they are optional and undocumented in the API. */
export interface SupervisionOptions {
  bootDeadlineMs?: number;
  jobTimeoutMs?: number;
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The handle on a container currently being supervised — what {@link
 * ciRunnerBootService.bootIntent} hands to every later step.
 *
 * ⚠️ JSON-SERIALIZABLE BY CONTRACT. It crosses a `ctx.step.run` boundary, so
 * Inngest round-trips it through JSON: every instant is an ISO STRING, not a
 * `Date`, because a `Date` survives the first pass and arrives as a string on
 * every replayed one — a difference that would otherwise show up as a
 * `.getTime is not a function` only in production, only on long jobs.
 */
export interface SupervisionSession {
  readonly intentId: string;
  readonly handle: {
    readonly provider: ContainerHandle['provider'];
    readonly id: string;
    readonly region: string;
    /** ISO-8601. */
    readonly createdAt: string;
  };
  readonly githubRunnerId: number | null;
  /** ISO-8601 — when the container was booted, the origin both deadlines run from. */
  readonly bootedAt: string;
  /** ISO-8601 — GitHub's own queue instant, which boot latency is measured from. */
  readonly queuedAt: string;
  readonly attribution: {
    readonly orgId: string;
    readonly workspaceId: string;
    readonly projectId: string;
    readonly repoFullName: string;
    readonly workflowJobId: number;
  };
}

/** What one poll observed. `done` is the ONLY way out of the loop, and it always
 *  leads to {@link ciRunnerBootService.settleSupervision}. */
export type PollResult =
  | {
      done: false;
      /** ISO-8601, once the container has been seen running. */
      startedAt: string | null;
      bootLatencyMs: number | null;
      /** Carried forward so the next poll can apply {@link MAX_CONSECUTIVE_READ_FAILURES}. */
      consecutiveReadFailures: number;
    }
  | {
      done: true;
      reason: TeardownReason;
      startedAt: string | null;
      bootLatencyMs: number | null;
      /** Set when the loop ended because the provider could not be read, so the
       *  settled intent can say so rather than reporting a bare timeout. */
      failureDetail: string | null;
    };

/** What {@link ciRunnerBootService.bootIntent} returns: either nothing was
 *  provisioned and the run is over, or a container is up and must be supervised
 *  to its end. */
export type BootResult =
  | { phase: 'terminal'; outcome: RunIntentOutcome }
  | { phase: 'supervising'; session: SupervisionSession };

/** The starting point of the poll loop — no reads yet, nothing observed. */
export const INITIAL_POLL_STATE: Extract<PollResult, { done: false }> = {
  done: false,
  startedAt: null,
  bootLatencyMs: null,
  consecutiveReadFailures: 0,
};

export type RunIntentOutcome =
  /** No such intent — it was deleted, or the id was stale. */
  | { outcome: 'unknown_intent' }
  /** Another provisioner claimed it first. NOT an error: the compare-and-set
   *  worked exactly as intended. */
  | { outcome: 'already_claimed' }
  /** THE ADMISSION GATE (MOTIR-1922) declined. The intent is still PENDING and
   *  the next sweep retries it — a job left queued, never a job failed, which is
   *  what a cap is supposed to feel like. */
  | { outcome: 'gate_deferred'; reason: AdmissionDeferralReason; detail: string }
  /** This deployment provisions no containers (self-hosted, or unwired). The
   *  claim is RELEASED so a configured instance can take it. */
  | { outcome: 'not_configured' }
  /**
   * GitHub could not be asked to register a runner right now. RETRYABLE — the
   * claim is released and the intent stays pending for the next sweep.
   *
   * TWO causes, deliberately one outcome (MOTIR-2011): the registration ceiling
   * is exhausted (`retryAfterSeconds` set, when GitHub said when), or the mint
   * did not answer inside its deadline (`retryAfterSeconds: null`). They differ
   * in what caused the wait and not at all in what the fleet should DO — the job
   * is early, not broken — and the typed error each path logs is what tells an
   * operator which one happened.
   */
  | { outcome: 'rate_limited'; retryAfterSeconds: number | null }
  /** The intent names no project, so there is no runner group and no tenant to
   *  bill. Refused (§7.3), never provisioned into the `Default` group. */
  | { outcome: 'no_runner_group'; detail: string }
  /** The container never existed: the mint or the boot was refused. */
  | { outcome: 'provision_failed'; detail: string }
  /**
   * THE RUNNER IMAGE COULD NOT BE PULLED — §6.2 of
   * `docs/decisions/fleet-image-pull.md`, split out of `provision_failed` so it
   * is a NAMED condition rather than one more generic provider 400.
   *
   * It earns its own arm because the remedy is categorically different from
   * every other provisioning failure: nothing about the job, the tenant or the
   * retry changes anything — a human has to fix the image's visibility, its
   * digest, or the mirror. Every queued job hits it identically, so a fleet in
   * this state produces a wall of failures that all say the same thing, and the
   * name is what lets an operator read that wall as ONE fault. The boot-time
   * preflight (`verifyFleetBootable()`, §6.1) is what should have caught it
   * first; this is the case where it was pullable then and is not now.
   */
  | { outcome: 'image_unpullable'; detail: string }
  /** A container ran and was torn down. `reason` says how it ended. */
  | {
      outcome: 'settled';
      reason: TeardownReason;
      containerId: string;
      billableSeconds: number;
      costUsd: string;
      bootLatencyMs: number | null;
      /** The §5 container-seconds record. Carried on the outcome so it reaches
       *  the `job_run` ledger, which stays the PER-RUN operational trail; since
       *  MOTIR-1924 the same record is also persisted to `ci_container_usage`
       *  by the sink, which is where it is queryable and attributed. */
      usage: ContainerUsage;
    };

function sleepFor(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : 'unknown';
}

export const ciRunnerBootService = {
  /**
   * STEP 1 OF THE DURABLE POLL LOOP — admit, mint, boot, and hand back a session
   * (MOTIR-2007).
   *
   * Everything that has to happen exactly once and costs money: the admission
   * gate + claim, the runner group, the JIT mint, the container boot. Bounded by
   * construction — a fixed handful of calls, no loop, no wait — so it fits inside
   * one invocation with room to spare.
   *
   * Returns `terminal` when nothing was provisioned (the run is over and the
   * caller returns the outcome), or `supervising` with the JSON-serializable
   * {@link SupervisionSession} every later step needs. Never throws for an
   * outcome it can name, for the reason {@link runIntent} never did: the caller
   * is a background job, and a throw is a retry that would mint a second runner.
   */
  async bootIntent(intentId: string, options: SupervisionOptions = {}): Promise<BootResult> {
    const outcome = await bootOnce(intentId, options);
    return outcome;
  },

  /**
   * STEP 2 (×N) — ONE provider read, and return.
   *
   * ⚠️ THIS IS THE WHOLE POINT OF THE CARD. It does exactly one
   * `orchestrator.describe`, applies the deadlines to what came back, and
   * returns. No loop, no sleep, no second call — so the step it runs in is
   * milliseconds, and the constraint cannot silently regress into a long step
   * again. The WAITING between polls is `ctx.step.sleep`, which costs no
   * invocation at all.
   *
   * ⚠️ AND IT NEVER THROWS. In a stepped world teardown cannot be reached from a
   * catch (see the module header), so guarantee 3 is structural: every failure
   * this can meet becomes a typed result, and the only exit is a `done` verdict
   * that the caller takes to {@link settleSupervision}.
   */
  async pollOnce(
    session: SupervisionSession,
    previous: Extract<PollResult, { done: false }> = INITIAL_POLL_STATE,
    options: SupervisionOptions = {},
  ): Promise<PollResult> {
    return pollContainerOnce(session, previous, options);
  },

  /**
   * STEP 3 — THE TEARDOWN, and the only way the loop ends.
   *
   * Destroys the container, de-registers the runner, records the container-seconds
   * and settles the intent — i.e. everything that used to live in `runIntent`'s
   * `finally`, now reachable as an ordinary step on the terminal branch rather
   * than as a language construct in a process that may already be dead.
   */
  async settleSupervision(
    session: SupervisionSession,
    verdict: Extract<PollResult, { done: true }>,
    options: SupervisionOptions = {},
  ): Promise<RunIntentOutcome> {
    return settleSupervisedContainer(session, verdict, options);
  },

  /**
   * Boot ONE intent and supervise it to its end, IN THIS PROCESS.
   *
   * ⚠️ NOT THE PRODUCTION PATH, and deliberately not reachable from one. The boot
   * JOB drives {@link bootIntent} / {@link pollOnce} / {@link settleSupervision}
   * as separate durable steps, which is the entire fix in MOTIR-2007 — calling
   * this from a job would rebuild the hour-long invocation the card removed, so
   * `tests/jobs/ci-runner-fleet.test.ts` asserts the handler does not.
   *
   * It survives because it is the honest in-process composition of the same three
   * operations, which is what lets the service suites drive a whole supervised
   * boot against real Postgres at millisecond deadlines. Any caller that is NOT a
   * durable job (a script, a local harness, a test) wants exactly this.
   */
  async runIntent(intentId: string, options: SupervisionOptions = {}): Promise<RunIntentOutcome> {
    const sleep = options.sleep ?? sleepFor;
    const booted = await this.bootIntent(intentId, options);
    if (booted.phase === 'terminal') return booted.outcome;

    let state = INITIAL_POLL_STATE;
    for (let iteration = 1; iteration <= MAX_POLL_ITERATIONS; iteration += 1) {
      await sleep(pollWaitMs(iteration, options));
      const polled = await this.pollOnce(booted.session, state, options);
      if (polled.done) return this.settleSupervision(booted.session, polled, options);
      state = polled;
    }
    // The static ceiling bound. Settle rather than abandon: a container nothing
    // tears down is the failure this whole file exists to prevent.
    return this.settleSupervision(
      booted.session,
      {
        done: true,
        reason: 'job_timed_out',
        startedAt: state.startedAt,
        bootLatencyMs: state.bootLatencyMs,
        failureDetail: `supervision hit the ${MAX_POLL_ITERATIONS}-poll ceiling`,
      },
      options,
    );
  },

  /**
   * THE REAPER (§4, §7.1's third guarantee). Destroy every fleet container older
   * than `olderThan`, whatever Motir's own tables believe, and settle the intents
   * that were holding them.
   *
   * ⚠️ IT QUERIES THE ORCHESTRATOR AGAINST THE INTENT TABLE, NEVER IN-PROCESS
   * STATE — the card's wording, and the reason is that the case it exists for is
   * the process that HELD that state having died. The provider is asked what
   * exists; the intent table is consulted only to attribute what came back.
   */
  async reapOrphans(
    options: { olderThan?: Date; now?: () => Date } = {},
  ): Promise<{ reaped: number; staleClaims: number; usages: ContainerUsage[] }> {
    if (!isOrchestratorConfigured()) return { reaped: 0, staleClaims: 0, usages: [] };
    const now = options.now ?? (() => new Date());
    const olderThan = options.olderThan ?? new Date(now().getTime() - DEFAULT_REAP_AFTER_MS);

    const orchestrator = getOrchestrator();
    const usages = await orchestrator.reap(olderThan, async (handle) => {
      const intent = await withSystemContext((tx) =>
        intents.findByContainerId(handle.provider, handle.id, tx),
      );
      if (!intent || !intent.projectId) return null;
      const workflowJobId = Number(intent.jobId);
      if (!Number.isInteger(workflowJobId)) return null;
      return {
        orgId: intent.organizationId,
        workspaceId: intent.workspaceId,
        projectId: intent.projectId,
        repoFullName: `${intent.repoOwner}/${intent.repoName}`,
        workload: CI_RUNNER_WORKLOAD,
        workflowJobId,
        size: FLEET_CONTAINER_SIZE,
        // A reaped container's start instant is whatever the provider still
        // reports; this process never observed it (that is what made it an
        // orphan), so there is nothing honest to fall back to.
        observedStartedAt: intent.startedAt,
      };
    });

    for (const usage of usages) {
      await recordContainerUsage(usage);
      const intent = await withSystemContext((tx) =>
        intents.findByContainerId(usage.provider, usage.handleId, tx),
      );
      if (!intent) continue;
      await deregisterQuietly(intent.githubRunnerId, intent.id);
      await settleIntent(intent.id, {
        status: CI_RUNNER_INTENT_FAILED,
        teardownReason: 'reaped',
        settledAt: now(),
        failureDetail: 'the container outlived its supervisor and was reaped',
      });
    }

    const staleClaims = await sweepStaleClaims(now);
    // The records ride out on the return value, into the `job_run` ledger.
    return { reaped: usages.length, staleClaims, usages };
  },

  /**
   * The provisioning SPEC for one intent — the port's provider-neutral shape.
   *
   * Exported (rather than inlined) because it is what MOTIR-1927's label-scoping
   * guard asserts against: the env the container receives, the single label the
   * JIT config was minted with, and the size §M fixes are all decided here, in
   * one readable place, and none of them is a Fly concept.
   */
  buildSpec(input: {
    intent: CiRunnerProvisioningIntent;
    workflowJobId: number;
    projectId: string;
    encodedJitConfig: string;
    timeoutSeconds: number;
    orchestrator: ContainerOrchestrator;
  }): ContainerSpec {
    const { intent, workflowJobId, projectId, encodedJitConfig, timeoutSeconds } = input;
    // The image and region are the Fly deployment's, but they are read through
    // the CONFIG accessor rather than the adapter's API surface, so the spec
    // stays provider-neutral. On the fake adapter neither is set, and the
    // defaults keep the spec well-formed.
    let image = 'motir/ci-runner@sha256:unset';
    let region = 'iad';
    try {
      const config = flyFleetConfig();
      image = config.image;
      region = config.region;
    } catch {
      // Not configured — the fake adapter path. The spec is still complete, and
      // the caller has already established that an orchestrator exists.
    }

    return {
      orgId: intent.organizationId,
      workspaceId: intent.workspaceId,
      projectId,
      repoFullName: `${intent.repoOwner}/${intent.repoName}`,
      // This service boots CI RUNNERS and nothing else. Saying so is what keeps
      // the machine's name and its fleet tag exactly what they were before the
      // port learned a second workload (MOTIR-2025).
      workload: CI_RUNNER_WORKLOAD,
      workflowJobId,
      image,
      size: FLEET_CONTAINER_SIZE,
      timeoutSeconds,
      region,
      env: {
        // The credential, injected at boot and never baked into the image (§4).
        ACTIONS_RUNNER_INPUT_JITCONFIG: encodedJitConfig,
        // ⚠️ `--no-default-labels`, which the card requires the boot to name.
        // The REAL guarantee is the JIT config: its `labels` array is the
        // runner's complete label set and GitHub adds no defaults to a JIT
        // runner. This flag is the second, independent statement of the same
        // requirement — the one that would still hold if the runner image ever
        // fell back to a `config.sh` path, where GitHub WOULD add
        // `self-hosted`/`Linux`/`X64` and a fleet runner would start matching
        // other tenants' `runs-on: self-hosted`.
        ACTIONS_RUNNER_CONFIG_ARGS: '--no-default-labels',
        MOTIR_RUNNER_LABEL,
        MOTIR_INTENT_ID: intent.id,
        MOTIR_WORKFLOW_JOB_ID: String(workflowJobId),
      },
    };
  },

  /** The pending-intent sweep — the interim trigger (see the module header: the
   *  hot path is MOTIR-1922's). Returns what it dispatched so the job can log it. */
  async listRunnableIntentIds(limit = 25): Promise<string[]> {
    if (!isOrchestratorConfigured()) return [];
    const pending = await withSystemContext((tx) => intents.listPending(limit, tx));
    return pending.map((intent) => intent.id);
  },
};

// ── the three bounded phases the durable poll loop drives ──────────────────

/**
 * The BOOT phase — admit + claim, resolve, mint, provision, record.
 *
 * This is the old `runIntent` up to and including `recordBoot`, unchanged in
 * behaviour and in the order it spends things. What changed is where it STOPS:
 * it hands back a session instead of falling into an hour-long supervision loop,
 * so it can live in a step.
 */
async function bootOnce(intentId: string, options: SupervisionOptions): Promise<BootResult> {
  const now = options.now ?? (() => new Date());
  const jobTimeoutMs = options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
  const terminal = (outcome: RunIntentOutcome): BootResult => ({ phase: 'terminal', outcome });

  const intent = await withSystemContext((tx) => intents.findById(intentId, tx));
  if (!intent) return terminal({ outcome: 'unknown_intent' });

  if (!isOrchestratorConfigured()) return terminal({ outcome: 'not_configured' });

  // THE ADMISSION GATE, which also takes THE CLAIM (atomic `pending →
  // provisioning`; the loser simply stops — see `claimPending` for why the
  // predicate is the whole guard). Nothing below this line is reachable for an
  // intent the caps or the credit state declined, which is the point: every
  // line after it costs money.
  //
  // ⚠️ AND IT IS NOW INSIDE A STEP, which is what finally makes the claim
  // taken ONCE PER RUN rather than once per durable-replay pass (the defect
  // MOTIR-2002 had to carry a memo column to work around). Step memoization
  // gives that for free.
  const verdict = await ciRunnerAdmissionService.admit(intent);
  if (verdict.outcome === 'already_claimed') return terminal({ outcome: 'already_claimed' });
  if (verdict.outcome === 'deferred') {
    console.warn('[ciRunnerBootService] the admission gate deferred an intent', {
      intentId,
      reason: verdict.reason,
      detail: verdict.detail,
    });
    return terminal({ outcome: 'gate_deferred', reason: verdict.reason, detail: verdict.detail });
  }

  // ── Everything the boot needs, resolved before anything is spent ──────────
  if (!intent.projectId) {
    // No project means no runner group (§7.3) and no tenant the container's
    // cost could be attributed to. Both are disqualifying on their own.
    await settleFailed(intentId, 'provision_failed', 'the intent names no project');
    return terminal({ outcome: 'no_runner_group', detail: 'the intent names no project' });
  }

  const workflowJobId = Number(intent.jobId);
  if (!Number.isInteger(workflowJobId) || workflowJobId <= 0) {
    await settleFailed(intentId, 'provision_failed', 'the intent has a malformed job id');
    return terminal({ outcome: 'provision_failed', detail: 'the intent has a malformed job id' });
  }

  let runnerGroupId: number;
  try {
    // ⚠️ REFUSES rather than falling back. §7.3: never the `Default` group (id
    // 1, `visibility: "all"`), which would silently restore the cross-tenant
    // pickup the per-project group exists to prevent — a runner booted for
    // project X taking project Y's job, including one the gate DECLINED.
    runnerGroupId = await projectRunnerGroupService.requireRunnerGroupId({
      projectId: intent.projectId,
      workspaceId: intent.workspaceId,
    });
  } catch (err) {
    const detail =
      err instanceof RunnerGroupNotProvisionedError
        ? err.message
        : `could not read the project's runner group: ${detailOf(err)}`;
    await settleFailed(intentId, 'provision_failed', detail);
    return terminal({ outcome: 'no_runner_group', detail });
  }

  let orchestrator: ContainerOrchestrator;
  try {
    orchestrator = getOrchestrator();
  } catch (err) {
    await releaseClaim(intentId);
    console.warn('[ciRunnerBootService] no orchestrator is configured — claim released', {
      intentId,
      detail: detailOf(err),
    });
    return terminal({ outcome: 'not_configured' });
  }

  // ── 1 · Mint the JIT config ───────────────────────────────────────────────
  // The credential the container receives. ONE runner, ONE config, no
  // registration capability inside the container (§7.4).
  const runnerName = runnerNameFor(intent);
  let jit;
  try {
    jit = await runnerJitConfigClient.mint({
      name: runnerName,
      runnerGroupId,
      // EXACTLY the one §M-compliant label. Not `self-hosted`, not `linux`, not
      // `x64`: a runner carrying GitHub's defaults would match some unrelated
      // tenant's `runs-on: self-hosted`, which is §7.3's cross-tenant pickup
      // arriving through the label axis instead of the group axis.
      labels: [MOTIR_RUNNER_LABEL],
    });
  } catch (err) {
    if (err instanceof RunnerRegistrationRateLimitedError) {
      // Early, not broken. Release the claim and let the next sweep try — a
      // burst against GitHub's 1,500-per-5-minutes ceiling is the gate's
      // problem to shape (§6), not a reason to fail a job.
      await releaseClaim(intentId);
      return terminal({ outcome: 'rate_limited', retryAfterSeconds: err.retryAfterSeconds });
    }
    if (err instanceof RunnerJitTimeoutError) {
      // THE MINT WHOSE ANSWER NEVER CAME (MOTIR-2011). GitHub registers the
      // runner BEFORE it responds (§7.4), so a blown deadline is the one failure
      // that may have created a runner we were never told the id of — a dangling
      // registered runner with nothing to name it by. It is hunted down by NAME
      // first, because the alternative is an offline runner sitting in the org's
      // list indistinguishable from a wedged fleet runner.
      //
      // Then treated exactly like the ceiling: the job is EARLY, not broken.
      // Failing it would dead-letter a run whose only sin is that a third party
      // was slow, and `retryPolicy: 'none'` means dead-lettered is where it would
      // stay.
      await deregisterByNameQuietly(runnerName, intentId);
      await releaseClaim(intentId);
      console.warn('[ciRunnerBootService] the JIT mint blew its deadline — claim released', {
        intentId,
        runnerName,
        timeoutMs: err.timeoutMs,
      });
      return terminal({ outcome: 'rate_limited', retryAfterSeconds: null });
    }
    const detail = `could not mint a JIT config: ${detailOf(err)}`;
    await settleFailed(intentId, 'provision_failed', detail);
    return terminal({ outcome: 'provision_failed', detail });
  }

  // Persist the runner id BEFORE booting. `generate-jitconfig` has already
  // registered the runner (§7.4), so from here on a crash without this column
  // would leave a dangling registered runner nobody can name.
  await withSystemContext((tx) =>
    intents.recordMintedRunner(
      intentId,
      { githubRunnerId: jit.runnerId, runnerName: jit.runnerName },
      tx,
    ),
  );

  // ── 2 · Boot exactly one container ────────────────────────────────────────
  const spec = ciRunnerBootService.buildSpec({
    intent,
    workflowJobId,
    projectId: intent.projectId,
    encodedJitConfig: jit.encodedJitConfig,
    timeoutSeconds: Math.ceil(jobTimeoutMs / 1000),
    orchestrator,
  });

  let handle: ContainerHandle;
  try {
    handle = await orchestrator.provision(spec);
  } catch (err) {
    // A MINTED-BUT-UNUSED JIT CONFIG. The runner is registered at GitHub and no
    // container will ever claim it, so it is de-registered here rather than
    // left to GitHub — which does not clean it up (§7.4, verified).
    await deregisterQuietly(jit.runnerId, intentId);

    // ⚠️ §6.2 of `docs/decisions/fleet-image-pull.md` — AN UNPULLABLE IMAGE IS
    // ITS OWN NAMED CONDITION, not a generic boot failure. It is the one
    // provisioning failure that is about the DEPLOYMENT rather than about this
    // job, so it settles with a detail that says which image and what the
    // registry said, and returns an outcome an operator can filter on.
    //
    // The teardown reason stays `provision_failed`: that column records how a
    // CONTAINER ended, and here there was never a container to end. Widening it
    // would put a boot-time diagnosis in a teardown vocabulary — and every
    // consumer of that enum would have to learn a value it can never observe.
    if (err instanceof OrchestratorImageUnpullableError) {
      const detail = `the runner image could not be pulled: ${detailOf(err)}`;
      console.error('[ciRunnerBootService] the runner image is not pullable', {
        intentId,
        image: err.imageReference,
        detail: detailOf(err),
      });
      await settleFailed(intentId, 'provision_failed', detail);
      return terminal({ outcome: 'image_unpullable', detail });
    }

    const detail = `could not boot a container: ${detailOf(err)}`;
    await settleFailed(intentId, 'provision_failed', detail);
    return terminal({ outcome: 'provision_failed', detail });
  }

  const bootedAt = now();
  await withSystemContext((tx) =>
    intents.recordBoot(
      intentId,
      {
        containerProvider: handle.provider,
        containerId: handle.id,
        containerRegion: handle.region,
        githubRunnerId: jit.runnerId,
        runnerName: jit.runnerName,
        bootedAt,
      },
      tx,
    ),
  );

  // ── 3 · Hand the loop everything it needs, as JSON ────────────────────────
  return {
    phase: 'supervising',
    session: {
      intentId,
      handle: {
        provider: handle.provider,
        id: handle.id,
        region: handle.region,
        createdAt: handle.createdAt.toISOString(),
      },
      githubRunnerId: jit.runnerId,
      bootedAt: bootedAt.toISOString(),
      queuedAt: intent.queuedAt.toISOString(),
      attribution: {
        orgId: intent.organizationId,
        workspaceId: intent.workspaceId,
        projectId: intent.projectId,
        repoFullName: `${intent.repoOwner}/${intent.repoName}`,
        workflowJobId,
      },
    },
  };
}

/**
 * ONE provider read, the deadlines applied to it, and a return.
 *
 * ⚠️ NEVER THROWS — see the module header. Every failure becomes a typed result,
 * because the only exit from the loop must be one the caller can take to
 * teardown.
 */
async function pollContainerOnce(
  session: SupervisionSession,
  previous: Extract<PollResult, { done: false }>,
  options: SupervisionOptions,
): Promise<PollResult> {
  const now = options.now ?? (() => new Date());
  const bootDeadlineMs = options.bootDeadlineMs ?? DEFAULT_BOOT_DEADLINE_MS;
  const jobTimeoutMs = options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
  const bootedAt = new Date(session.bootedAt).getTime();
  const queuedAt = new Date(session.queuedAt).getTime();

  let startedAt = previous.startedAt;
  let bootLatencyMs = previous.bootLatencyMs;

  /** The deadline check both the happy and the failed-read paths fall through
   *  to, so a provider that is down can never extend a container past its
   *  timeout. */
  const deadlineVerdict = (failureDetail: string | null): PollResult | null => {
    const elapsed = now().getTime() - bootedAt;
    if (!startedAt && elapsed >= bootDeadlineMs) {
      return {
        done: true,
        reason: 'provision_failed',
        startedAt: null,
        bootLatencyMs: null,
        failureDetail,
      };
    }
    if (elapsed >= jobTimeoutMs) {
      return { done: true, reason: 'job_timed_out', startedAt, bootLatencyMs, failureDetail };
    }
    return null;
  };

  let status;
  try {
    status = await orchestratorFor(session).describe({
      provider: session.handle.provider,
      id: session.handle.id,
      region: session.handle.region,
      createdAt: new Date(session.handle.createdAt),
    });
  } catch (err) {
    // ⚠️ A SINGLE PROVIDER BLIP MUST NOT KILL A CUSTOMER'S JOB. Without this
    // tolerance one 500 from the provider ends a healthy CI run for a reason
    // that has nothing to do with the customer's code. The deadlines are still
    // the real bound — this only buys the loop the right to MISS a few reads,
    // never the right to run longer.
    const consecutiveReadFailures = previous.consecutiveReadFailures + 1;
    const detail = detailOf(err);
    if (consecutiveReadFailures > MAX_CONSECUTIVE_READ_FAILURES) {
      // Give up on reading, but NOT on tearing down: a `done` verdict is what
      // routes this to teardown, which is why this returns rather than throws.
      return {
        done: true,
        reason: 'job_timed_out',
        startedAt,
        bootLatencyMs,
        failureDetail: `the container status could not be read: ${detail}`,
      };
    }
    console.warn('[ciRunnerBootService] a container status read failed — retrying', {
      containerId: session.handle.id,
      provider: session.handle.provider,
      consecutiveReadFailures,
      detail,
    });
    return (
      deadlineVerdict(null) ?? { done: false, startedAt, bootLatencyMs, consecutiveReadFailures }
    );
  }

  if (status.startedAt && !startedAt) {
    startedAt = status.startedAt.toISOString();
    // ⚠️ MEASURED FROM `queuedAt`, GitHub's own instant — not from our receipt
    // of the webhook and not from the boot. §6's budget is the span a USER
    // experiences as "CI is slow to start", and the queue time before Motir even
    // heard about the job is part of that.
    bootLatencyMs = Math.max(0, status.startedAt.getTime() - queuedAt);
  }

  if (status.terminal) {
    // Gone or stopped. If it never started, the runner never registered — the
    // "boot succeeded but nothing came up" path, which is a provisioning
    // failure even though the provider reported success.
    const observed = startedAt ?? status.startedAt?.toISOString() ?? null;
    return {
      done: true,
      reason: observed ? 'job_completed' : 'provision_failed',
      startedAt: observed,
      bootLatencyMs,
      failureDetail: null,
    };
  }

  return (
    deadlineVerdict(null) ?? { done: false, startedAt, bootLatencyMs, consecutiveReadFailures: 0 }
  );
}

/**
 * TEARDOWN — what used to be `runIntent`'s `finally`, as an ordinary step on the
 * loop's only exit.
 */
async function settleSupervisedContainer(
  session: SupervisionSession,
  verdict: Extract<PollResult, { done: true }>,
  options: SupervisionOptions,
): Promise<RunIntentOutcome> {
  const now = options.now ?? (() => new Date());
  const { intentId } = session;
  const observedStartedAt = verdict.startedAt ? new Date(verdict.startedAt) : null;
  const handle: ContainerHandle = {
    provider: session.handle.provider,
    id: session.handle.id,
    region: session.handle.region,
    createdAt: new Date(session.handle.createdAt),
  };

  // The started instant is recorded here rather than mid-loop: it is known once
  // and only matters once, and a write per poll would be a write per step.
  if (observedStartedAt && verdict.bootLatencyMs !== null) {
    await withSystemContext((tx) =>
      intents.recordStarted(intentId, observedStartedAt, verdict.bootLatencyMs as number, tx),
    );
  }

  let orchestrator: ContainerOrchestrator;
  try {
    orchestrator = orchestratorFor(session);
  } catch (err) {
    // No orchestrator to tear down THROUGH. Leave the intent in flight for the
    // reaper rather than settling a container that may still be running.
    console.error('[ciRunnerBootService] no orchestrator at teardown — left for the reaper', {
      intentId,
      containerId: handle.id,
      detail: detailOf(err),
    });
    return {
      outcome: 'provision_failed',
      detail: `no orchestrator at teardown for container ${handle.id}; left for the reaper`,
    };
  }

  // ⚠️ THE GUARANTEE. Every path out of supervision arrives here — completed,
  // timed out, never started, and unreadable. `teardown` is idempotent, so the
  // reaper reaching the same container later is harmless.
  const usage = await teardownQuietly(orchestrator, handle, verdict.reason, {
    orgId: session.attribution.orgId,
    workspaceId: session.attribution.workspaceId,
    projectId: session.attribution.projectId,
    repoFullName: session.attribution.repoFullName,
    workload: CI_RUNNER_WORKLOAD,
    workflowJobId: session.attribution.workflowJobId,
    size: FLEET_CONTAINER_SIZE,
    observedStartedAt,
  });
  await deregisterQuietly(session.githubRunnerId, intentId);

  if (usage) {
    await recordContainerUsage(usage);
    await settleIntent(intentId, {
      status:
        verdict.reason === 'job_completed' ? CI_RUNNER_INTENT_COMPLETED : CI_RUNNER_INTENT_FAILED,
      teardownReason: verdict.reason,
      settledAt: now(),
      failureDetail: verdict.failureDetail,
      startedAt: observedStartedAt,
      bootLatencyMs: verdict.bootLatencyMs,
    });
    return {
      outcome: 'settled',
      reason: verdict.reason,
      containerId: handle.id,
      billableSeconds: usage.billableSeconds,
      costUsd: usage.costUsd,
      bootLatencyMs: verdict.bootLatencyMs,
      usage,
    };
  }

  // Teardown itself failed. The intent stays IN FLIGHT deliberately: marking it
  // settled would hide a container that may still be running from the one
  // mechanism that can still catch it. The reaper owns it now.
  console.error(
    '[ciRunnerBootService] teardown failed — the intent is left in flight for the reaper',
    { intentId, containerId: handle.id, provider: handle.provider },
  );
  return {
    outcome: 'provision_failed',
    detail: `teardown failed for container ${handle.id}; left for the reaper`,
  };
}

/** The orchestrator a session's container lives on. Re-read per step rather than
 *  carried across the boundary, because an adapter is not serializable — the
 *  handle is, which is exactly why the port made it opaque. */
function orchestratorFor(_session: SupervisionSession): ContainerOrchestrator {
  return getOrchestrator();
}

// ── internals ─────────────────────────────────────────────────────────────

/** Tear down, swallowing a failure into null. The caller decides what a null
 *  means; what it must NOT do is propagate out of a `finally` and mask the
 *  reason the code got there. */
async function teardownQuietly(
  orchestrator: ContainerOrchestrator,
  handle: ContainerHandle,
  reason: TeardownReason,
  attribution: UsageAttribution,
) {
  try {
    return await orchestrator.teardown(handle, reason, attribution);
  } catch (err) {
    console.error('[ciRunnerBootService] could not tear down a container', {
      containerId: handle.id,
      provider: handle.provider,
      reason,
      detail: detailOf(err),
    });
    return null;
  }
}

/** De-register the GitHub runner. Idempotent and best-effort: on the happy path
 *  the ephemeral runner already de-registered itself and GitHub answers 404,
 *  which the client treats as success. */
async function deregisterQuietly(runnerId: number | null, intentId: string): Promise<void> {
  if (runnerId === null) return;
  try {
    await runnerJitConfigClient.deleteRunner(runnerId);
  } catch (err) {
    console.error(
      '[ciRunnerBootService] could not de-register a runner — it may be left dangling',
      { intentId, runnerId, detail: detailOf(err) },
    );
  }
}

/**
 * De-register the runner a TIMED-OUT mint may have registered — the only cleanup
 * path that has no id to work from (MOTIR-2011).
 *
 * Quiet for the same reason {@link deregisterQuietly} is: this runs on a failure
 * path whose job is already going back in the queue, and a cleanup that throws
 * would replace a retryable outcome with an untyped one. A runner that could not
 * be removed is logged loudly and left to `sweepStaleClaims`.
 */
async function deregisterByNameQuietly(runnerName: string, intentId: string): Promise<void> {
  try {
    const removed = await runnerJitConfigClient.deleteRunnersNamed(runnerName);
    if (removed.length > 0) {
      console.warn('[ciRunnerBootService] de-registered a runner left by a timed-out mint', {
        intentId,
        runnerName,
        runnerIds: removed,
      });
    }
  } catch (err) {
    console.error(
      '[ciRunnerBootService] could not de-register a timed-out mint — a runner may be dangling',
      { intentId, runnerName, detail: detailOf(err) },
    );
  }
}

async function settleIntent(
  intentId: string,
  record: {
    status: string;
    teardownReason: string | null;
    settledAt: Date;
    failureDetail: string | null;
    startedAt?: Date | null;
    bootLatencyMs?: number | null;
  },
): Promise<void> {
  try {
    await withSystemContext((tx) => intents.settle(intentId, record, tx));
  } catch (err) {
    console.error('[ciRunnerBootService] could not settle an intent', {
      intentId,
      detail: detailOf(err),
    });
  }
}

async function settleFailed(
  intentId: string,
  reason: TeardownReason,
  detail: string,
): Promise<void> {
  await settleIntent(intentId, {
    status: CI_RUNNER_INTENT_FAILED,
    teardownReason: reason,
    settledAt: new Date(),
    failureDetail: detail.slice(0, 300),
  });
}

/** Put a claimed intent back in the pending pool — for refusals that are about
 *  the ENVIRONMENT (unconfigured, rate-limited) rather than about the job. The
 *  gate releases the same way for a credit refusal, through the same repository
 *  method, so a re-queued intent looks identical whichever path re-queued it. */
async function releaseClaim(intentId: string): Promise<void> {
  await ciRunnerAdmissionService.releaseClaim(intentId);
}

/**
 * Intents claimed but never booted — the crash-between-mint-and-boot window.
 *
 * The container (if any) is the provider's problem and the reaper's; what is
 * left HERE is a registered GitHub runner with no machine, which is exactly the
 * dangling-JIT case §7.4 requires be de-registered rather than left. This is
 * where the `githubRunnerId` written before the boot earns its column.
 */
async function sweepStaleClaims(now: () => Date): Promise<number> {
  const claimedBefore = new Date(now().getTime() - STALE_CLAIM_MS);
  const stale = await withSystemContext((tx) => intents.listStaleClaims(claimedBefore, 50, tx));
  for (const intent of stale) {
    await deregisterQuietly(intent.githubRunnerId, intent.id);
    await settleIntent(intent.id, {
      status: CI_RUNNER_INTENT_FAILED,
      teardownReason: 'provision_failed',
      settledAt: now(),
      failureDetail: 'claimed but never booted; the minted runner was de-registered',
    });
  }
  return stale.length;
}

/**
 * The runner's NAME at GitHub. Deterministic and attributable, for the reason
 * `runnerGroupNameFor` is: an offline runner left in the org's list is traceable
 * to the job it was minted for with no reverse lookup.
 *
 * GitHub caps runner names at 64 characters, and a cuid intent id plus the prefix
 * fits comfortably — but it is truncated rather than trusted, because a name
 * GitHub refuses would fail the mint and queue the job for 24 hours.
 */
function runnerNameFor(intent: CiRunnerProvisioningIntent): string {
  return `motir-${intent.id}`.slice(0, 64);
}
