import { mintCodeGraphRunCredential, motirAiBaseUrl } from '@/lib/ai/motirAiClient';
import {
  codeGraphIndexAdmissionService,
  type IndexAdmission,
  type IndexAdmissionDeferralReason,
  type IndexAdmissionVerdict,
} from '@/lib/services/codeGraphIndexAdmissionService';
import { getGitProvider, requireRepoTarballUrlResolver } from '@/lib/git';
import type { GitProviderId } from '@/lib/git/types';
import type { FleetWorkloadKind } from '@/lib/ciFleet/workloads';
import {
  getOrchestrator,
  indexFleetConfig,
  OrchestratorImageUnpullableError,
  type IndexFleetConfig,
} from '@/lib/orchestrator';
import { FLEET_CONTAINER_SIZE } from '@/lib/orchestrator/rates';
import { buildContainerAccrual } from '@/lib/orchestrator/usage';
import { recordContainerAccrual, recordContainerUsage } from '@/lib/orchestrator/usageSink';
import type {
  ContainerHandle,
  ContainerOrchestrator,
  ContainerSpec,
  ContainerUsage,
  TeardownReason,
  UsageAttribution,
} from '@/lib/orchestrator/types';

// THE INDEX DISPATCH SERVICE (Story MOTIR-1981 · MOTIR-2026) — boot ONE index
// container, supervise it in BOUNDED steps, and turn what happened into a typed
// outcome.
//
// `docs/decisions/code-graph-index-fleet.md` §2 (a container, not a function),
// §4 (credential scope is the isolation boundary), §5 (the container builds;
// motir-ai is control plane), §10 (no GitHub credential).
//
// ⚠️ IT OWNS NO INNGEST STEPS. It exposes three individually-BOUNDED operations
// — {@link codeGraphIndexDispatchService.bootIndexContainer} /
// {@link codeGraphIndexDispatchService.pollIndexContainer} /
// {@link codeGraphIndexDispatchService.settleIndexContainer} — which the step
// shape (MOTIR-2027) drives as durable steps. The split is not stylistic: an
// index run is minutes (a whole-repo tarball fetch plus a build measured at 924
// MB peak RSS, MOTIR-1515) and `app/api/inngest/route.ts` pins
// `maxDuration = 300`. Supervision inside ONE invocation is exactly the defect
// MOTIR-2007 fixed for the CI fleet — the supervisor was killed mid-loop and the
// teardown, the cost row and the ledger result went with it. `ciRunnerBootService`
// is the shipped shape this mirrors, down to its rule that the poll NEVER THROWS
// (in a stepped world teardown cannot be reached from a `catch`, so every failure
// becomes a typed result and the only exit is a `done` verdict that routes to
// teardown).
//
// ⚠️ ONE CONTAINER PER (REPO × PROJECT), AND THE LEDGER IS STILL PER REPO. The
// shipped indexer image reads exactly ONE `MOTIR_INDEX_RUN_CREDENTIAL` and
// returns exactly ONE pointer, and `runCredential` binds a credential to ONE
// `aiProjectId` resolved AT MINT TIME — "a container never names it"
// (`motir-ai/docs/contract.md`: nothing in a request body can name a project).
// `codeGraphIndexService.resolveIndexTarget` fans out over every project of the
// repo's workspace, so indexing one repo into N projects needs N credentials and
// therefore N containers. That does NOT weaken §6: §6 forbids batching several
// REPOS into one container, because one `output.repoRef` for N repos leaves N−1
// reading as never-indexed forever. One container per (repo × project) never
// batches repos, so the ledger stays one `job_run` per repo with one
// `output.repoRef` — the contract `listSucceededCodeGraphIndexRepoRefs` and the
// onboarding wizard's per-repo rows read. This service dispatches ONE
// (repo × project); who loops and who writes the ledger row is MOTIR-2027's.
//
// ⚠️ THE SPEC IS A SECURITY BOUNDARY, NOT A CONFIG BLOB. §4 makes credential
// scope the isolation mechanism for a fleet whose org is SHARED with CI runners
// executing customer-authored code, so what a container holds is the whole of its
// blast radius. {@link codeGraphIndexDispatchService.buildIndexSpec} therefore
// takes every value as an ARGUMENT and reads no environment of its own: the four
// variables the image's boot contract names are the four it emits, and the test
// asserts the key SET rather than its members, so a fifth variable added later
// fails rather than passing unnoticed. Above all there is no Fly token in it — a
// container ingesting untrusted source with one could provision in the shared
// fleet org (MOTIR-1918 §7.4).
//
// ⚠️ NO `isMeta` BRANCH EXISTS ANYWHERE IN THIS PATH — §8/§9, and it is
// load-bearing rather than an omission. Motir's own repos dispatch through this
// identical code, into the same org, with the same credential shape; `isMeta`
// decides only whether the metered cost is CHARGED (§9.1: read every `isMeta`
// branch as "should this be un-charged?", never as "should this run somewhere
// else?"). A meta-only path would mean the tested path is the one nobody runs.
//
// ⚠️ NOTHING BOOTS WITHOUT AN ADMISSION (MOTIR-1990). `bootIndexContainer`
// REQUIRES an {@link IndexAdmission} — the granted ticket
// `codeGraphIndexAdmissionService.admit` returns once it has taken a
// `fleet_in_flight_slot` under the fleet lock. That is the same compile-time
// trick the repository layer uses with `tx` (CLAUDE.md: *"required so TypeScript
// catches missing-tx bugs"*): booting an index container outside the cap is a
// type error rather than a review comment. NO concurrency number is inlined in
// this file — every one of them is config, read in `lib/ciFleet/limits.ts`.
//
// The slot's LIFETIME is this service's: taken by the admission, released by
// {@link codeGraphIndexDispatchService.settleIndexContainer} once the container
// is really gone — and by `bootIndexContainer` itself on every path where the
// boot did not leave a container behind, so a failed mint or an unpullable image
// gives capacity straight back instead of holding it until the TTL.
//
// ⚠️ WHAT THIS DELIBERATELY DOES NOT DO. `system.code-graph-refresh` and
// motir-ai's hydrate-on-read path are
//
// ⚠️ THE COGS METER IS NOW WIRED (MOTIR-1995). MOTIR-2026 carried the usage record
// OUT on the outcome and wrote no row, because attributing it was this card's. It
// is attributed here, at the two moments a container's cost becomes knowable, and
// both go through `usageSink` — never the meter service directly, so the port keeps
// knowing nothing about tenancy:
//
//   * {@link codeGraphIndexDispatchService.settleIndexContainer} → `recordContainerUsage`.
//     Teardown produces the record and the port makes that unskippable.
//   * {@link codeGraphIndexDispatchService.pollIndexContainer} → `recordContainerAccrual`.
//     A CHECKPOINT while the container still runs. An index container is job-shaped
//     and would survive without it; it is here because the supervision loop is where
//     a live container's seconds are observable at all, and Epic 9's agent container
//     — story-shaped, HOURS — reaches teardown far too late to be the first write.
//     Building it while the loop is being written costs nothing; retrofitting it
//     after Epic 9 ships costs a migration and a period of blind spend.
//
// Neither call can throw (`usageSink`'s contract), which is what lets them sit on a
// path documented to never throw and inside the `finally`-shaped settle.
//
// ⚠️ NO `isMeta` BRANCH HERE EITHER, and now none in the meter it feeds. Motir's own
// repos dispatch through this identical code into the same org; the meter measures
// them like any tenant and reads their cost back as its own line. See §9.1 and the
// meter's header: `isMeta` decides whether spend is CHARGED, never whether it is
// MEASURED.

/** This service dispatches INDEX containers and nothing else. Named once so the
 *  answer to "does it ever boot anything else?" is one grep, not four literals. */
const CODE_GRAPH_INDEX_WORKLOAD = 'code_graph_index' satisfies FleetWorkloadKind;

/**
 * An index container has NO GitHub job — §11: "no runner registers, no `runs-on`
 * resolves, no `workflow_job` fires". The port made `workflowJobId` nullable for
 * exactly this workload (MOTIR-2025); filling it would name the machine after a
 * job that does not exist and tag it as a CI runner to the reaper.
 */
const NO_WORKFLOW_JOB = null;

/**
 * The attribution every cost record for this container carries — built ONCE from
 * the session (MOTIR-1995), because the checkpoint and the teardown must attribute
 * the SAME container the same way or the settle's delta would land on a different
 * rollup line than the accrual it is reconciling.
 *
 * `observedStartedAt` is the caller's own observation, which for an index container
 * is usually the ONLY start instant available: `auto_destroy` means a healthy run
 * ends with the machine deleting itself, taking its event log with it, so without
 * this the best-behaved containers would produce the zero-second rows.
 */
function indexUsageAttribution(
  session: IndexSession,
  observedStartedAt: Date | null = null,
): UsageAttribution {
  return {
    orgId: session.attribution.orgId,
    workspaceId: session.attribution.workspaceId,
    projectId: session.attribution.projectId,
    repoFullName: session.attribution.repoFullName,
    workload: CODE_GRAPH_INDEX_WORKLOAD,
    workflowJobId: NO_WORKFLOW_JOB,
    size: FLEET_CONTAINER_SIZE,
    observedStartedAt,
  };
}

/** How long a container has to reach a running state before it is written off as
 *  a boot that never happened. Same figure the CI fleet uses: a deadline that
 *  cannot fire on a merely-slow boot. */
const DEFAULT_BOOT_DEADLINE_MS = 120_000;

/**
 * The hard kill on ONE index run.
 *
 * Half an hour, not the CI fleet's hour. §11.1 fixes the asymmetry the number
 * comes from: an index container is JOB-shaped (minutes) where an agent container
 * is story-shaped (hours), and the measured run is a tarball fetch plus a build
 * that peaks at 924 MB RSS (MOTIR-1515) — an order of magnitude under this. What
 * is fixed here is not how long an index may take but that the CONTAINER STOPS:
 * every further second is billed to Motir with, per §7.2, nothing but Motir's own
 * counter in front of the invoice.
 */
const DEFAULT_INDEX_TIMEOUT_MS = 1_800_000;

/** How soon after boot supervision first asks the provider what the container is
 *  doing. */
const DEFAULT_POLL_INTERVAL_MS = 3_000;

/**
 * The ceiling the poll interval backs off to — DELIBERATELY HALF THE CI FLEET'S.
 *
 * For a CI runner, detection latency is nearly free: the runner reports to
 * GitHub, `auto_destroy` stops the machine either way, and a later observation
 * delays only the teardown call and the usage row. FOR AN INDEX CONTAINER IT IS
 * NOT FREE, because the exit code is the entire diagnostic channel and it is
 * READABLE ONLY WHILE THE MACHINE STILL EXISTS — the Fly adapter's `describe`
 * reports `exitCode: null` for a machine that is gone ("GONE takes the exit code
 * with it"). Every second of extra poll spacing is a second in which a finished
 * container can self-destroy unobserved and turn a knowable `30` into
 * {@link IndexExitClass} `exit_unobserved`. So the backoff still bounds the step
 * count on a long run, but it stops sooner.
 */
const MAX_POLL_INTERVAL_MS = 15_000;

/** How much the poll interval grows each time the container is not yet terminal,
 *  until it reaches {@link MAX_POLL_INTERVAL_MS}. */
const POLL_BACKOFF_FACTOR = 2;

/**
 * A hard ceiling on poll iterations, independent of the clock — the bound that
 * still holds if the clock does something surprising (a frozen `now`, a provider
 * that never reports terminal). A durable loop with no static bound is a runaway
 * that bills per iteration. At the interval above it is many times the timeout.
 */
const MAX_POLL_ITERATIONS = 500;

/**
 * How many CONSECUTIVE provider status reads may fail before supervision gives up
 * and tears the container down. Not zero, because one 500 from the provider must
 * not end a healthy index; not unbounded, because a provider that is genuinely
 * unreachable must not leave this loop watching a container forever.
 */
const MAX_CONSECUTIVE_READ_FAILURES = 3;

/**
 * THE INDEX FLEET'S TIME BUDGETS, stated once and asserted in the suite.
 *
 * Read `maxDuration` (300s, `app/api/inngest/route.ts`) as the ceiling on ONE
 * INVOCATION — i.e. on one step — never on a run, exactly as
 * `FLEET_TIME_BUDGETS` does for CI. Then:
 *
 *   • Each of boot / poll / settle is a fixed, small amount of work: a handful of
 *     external calls, no loop and no sleep inside any of them.
 *   • `indexTimeoutMs` > `maxDuration · 1000` is DELIBERATE and only safe because
 *     the RUN is stepped: no single step spans it. Shortening it to fit one
 *     invocation would cap every index at five minutes — the product regressing
 *     to fit the platform.
 *   • `pollIntervalMs` ≤ `maxPollIntervalMs` < `bootDeadlineMs` < `indexTimeoutMs`,
 *     so the boot deadline is observable at poll granularity and can fire before
 *     the run timeout does.
 */
export const INDEX_FLEET_TIME_BUDGETS = {
  bootDeadlineMs: DEFAULT_BOOT_DEADLINE_MS,
  indexTimeoutMs: DEFAULT_INDEX_TIMEOUT_MS,
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  maxPollIntervalMs: MAX_POLL_INTERVAL_MS,
  maxPollIterations: MAX_POLL_ITERATIONS,
  maxConsecutiveReadFailures: MAX_CONSECUTIVE_READ_FAILURES,
} as const;

/** The first wait after a deferred admission. */
const ADMISSION_RETRY_BASE_MS = 5_000;

/** The ceiling the admission wait backs off to. A minute is short next to the
 *  half-hour a container may hold its slot for, so a freed slot is claimed
 *  promptly rather than after an idle lane. */
const ADMISSION_RETRY_MAX_MS = 60_000;

const ADMISSION_RETRY_FACTOR = 2;

/**
 * How many times a dispatch asks for admission before it gives up WAITING.
 *
 * ⚠️ OVER THE CAP MEANS WAIT, NEVER DROP — that is the card's rule and the reason
 * this number is what it is. Dropping an index leaves a repo permanently
 * unindexed behind a `succeeded`-looking ledger, which is the exact failure §6's
 * one-row-per-repo contract exists to remove.
 *
 * Sixty attempts on the backoff above is a little under an hour of waiting, which
 * is DELIBERATELY LONGER THAN THE LONGEST CONTAINER: {@link
 * DEFAULT_INDEX_TIMEOUT_MS} hard-kills at thirty minutes, so every container
 * holding a slot when this dispatch first queued has certainly ended before the
 * budget runs out — the lane cannot still be full for the same reason it was
 * full at the start. Exhausting it therefore means something is wrong with the
 * FLEET rather than busy, and that is a loud failure (a failed `job_run` an
 * operator can see), never a silent skip.
 *
 * A bound rather than an unbounded wait for the same reason the poll loop has
 * one: a durable loop with no static ceiling is a runaway, and Inngest's own
 * retry budget is the outer recovery for the case this one hits.
 */
const MAX_ADMISSION_ATTEMPTS = 60;

/** The admission-side budgets, stated once and asserted in the suite. */
export const INDEX_ADMISSION_BUDGETS = {
  maxAttempts: MAX_ADMISSION_ATTEMPTS,
  baseWaitMs: ADMISSION_RETRY_BASE_MS,
  maxWaitMs: ADMISSION_RETRY_MAX_MS,
} as const;

/** Seams the tests drive. Defaults are the constants above. */
export interface IndexSupervisionOptions {
  bootDeadlineMs?: number;
  indexTimeoutMs?: number;
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  /** The admission backoff's base + ceiling, so a queueing test is milliseconds. */
  admissionWaitMs?: number;
  maxAdmissionWaitMs?: number;
  /** How many times the in-process composition asks for admission before giving
   *  up. Bounded by {@link MAX_ADMISSION_ATTEMPTS} — a test may lower it, never
   *  raise it past the shipped ceiling. */
  maxAdmissionAttempts?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

/** ONE (repo × project) dispatch — everything the boot needs, already resolved.
 *  It is the shape `codeGraphIndexService`'s phase-1 read produces, plus the run
 *  the credential is minted for. */
export interface IndexDispatchInput {
  /** The host installation id — the token-minting key for the URL resolve. The
   *  token itself never leaves this process (§10). */
  readonly installationId: string;
  readonly providerId: GitProviderId;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly repoOwner: string;
  readonly repoName: string;
  /** `owner/name` — the SAME key the ledger and the enqueue gate match on. */
  readonly repoRef: string;
  /** The ref to index — the repo's default branch. */
  readonly defaultBranch: string;
  /** The dispatching run, carried into the credential for attribution. */
  readonly runId: string;
}

/**
 * The handle on an index container being supervised.
 *
 * ⚠️ JSON-SERIALIZABLE BY CONTRACT. It crosses a `ctx.step.run` boundary, so
 * Inngest round-trips it through JSON: every instant is an ISO STRING, never a
 * `Date` — a `Date` survives the first pass and arrives as a string on every
 * replayed one, a difference that shows up as `.getTime is not a function` only
 * in production and only on long runs.
 */
export interface IndexSession {
  readonly handle: {
    readonly provider: ContainerHandle['provider'];
    readonly id: string;
    readonly region: string;
    /** ISO-8601. */
    readonly createdAt: string;
  };
  /** ISO-8601 — when the container was booted; both deadlines run from it. */
  readonly bootedAt: string;
  /** ISO-8601 — when this run's motir-ai credential stops working. Carried so a
   *  post-mortem can tell an expiry apart from a scope refusal, both of which the
   *  container reports as `50`. */
  readonly credentialExpiresAt: string;
  readonly runId: string;
  readonly repoRef: string;
  /**
   * The `fleet_in_flight_slot` this container occupies (MOTIR-1990).
   *
   * Carried on the SESSION, not held in a closure, precisely because the session
   * is the only thing that crosses the step boundary: the admission happens in
   * one durable step and the release happens in another, minutes later, possibly
   * in a different invocation. A slot whose ref lived only in memory would be a
   * slot nothing could ever give back.
   */
  readonly slotRef: string;
  readonly attribution: {
    readonly orgId: string;
    readonly workspaceId: string;
    readonly projectId: string;
    readonly repoFullName: string;
  };
}

/** What one poll observed. `done` is the ONLY way out of the loop, and it always
 *  leads to {@link codeGraphIndexDispatchService.settleIndexContainer}. */
export type IndexPollResult =
  | {
      done: false;
      /** ISO-8601, once the container has been seen running. */
      startedAt: string | null;
      /** Carried forward so the next poll can apply the read-failure tolerance. */
      consecutiveReadFailures: number;
    }
  | {
      done: true;
      reason: TeardownReason;
      startedAt: string | null;
      /** The container's own exit status, when the provider still reported one. */
      exitCode: number | null;
      /** Set when supervision ended for a reason of its own (a deadline, an
       *  unreadable provider) rather than because the container stopped. */
      failureDetail: string | null;
    };

/** The starting point of the poll loop — no reads yet, nothing observed. */
export const INITIAL_INDEX_POLL_STATE: Extract<IndexPollResult, { done: false }> = {
  done: false,
  startedAt: null,
  consecutiveReadFailures: 0,
};

/**
 * WHAT THE RUN DID, named from the image's own taxonomy
 * (`motir-ai/src/indexer/exitCodes.ts`) rather than left as a number.
 *
 * The container writes no ledger row and its logs are the operator's, so the exit
 * code is the entire diagnostic channel: "the repo could not be fetched", "the
 * parser died on this tree" and "motir-ai refused the pointer" are three
 * different on-call responses and must be three different values here.
 */
export type IndexExitClass =
  /** `0` — built, uploaded, pointer recorded. The ONLY class that indexed. */
  | 'indexed'
  /** `10` — a required variable was missing or blank; NOTHING was attempted. A
   *  bug in this dispatcher: a retry with the same spec fails identically. */
  | 'dispatch_malformed'
  /** `20` — the repo could not be obtained (URL refused, transfer failed, or the
   *  archive was unreadable). Often an expired pre-signed URL. */
  | 'repo_unfetchable'
  /** `30` — the source arrived and the engine could not build a graph from it. */
  | 'graph_unbuildable'
  /** `40` — object storage refused or dropped the PUT to the granted key. */
  | 'upload_failed'
  /** `41` — the object landed and motir-ai refused to move the pointer. Inert:
   *  the key is derived from the commit, so a retry overwrites it. */
  | 'pointer_unrecorded'
  /** `50` — the run-scoped credential was REFUSED (expired, or out of scope). */
  | 'credential_refused'
  /** `137` — the KERNEL OOM-killed it: the machine was too small for this tree.
   *  A different fact from `graph_unbuildable`, and never merged into it. */
  | 'out_of_memory'
  /** `70`, or any code the taxonomy does not name. */
  | 'unclassified'
  /** The container stopped and no exit code was observable — `auto_destroy` took
   *  it with the machine. A third outcome beside "exited 0" and "exited 30". */
  | 'exit_unobserved'
  /** The container never started: the boot deadline fired first. */
  | 'never_started'
  /** Supervision gave up — its own deadline, or a provider it could not read. */
  | 'supervision_timed_out';

/** The exit, classified: what happened, and what a caller may conclude from it. */
export interface IndexExitVerdict {
  readonly exitClass: IndexExitClass;
  /** The raw code, kept beside the class so an unnamed number is still legible. */
  readonly exitCode: number | null;
  /**
   * ⚠️ TRUE ONLY FOR EXIT `0`. Everything downstream that claims a repo has a
   * code graph — the `job_run` ledger row, `listSucceededCodeGraphIndexRepoRefs`,
   * the wizard's per-repo rows — gates on this, so an unobserved or ambiguous
   * exit must never set it. §6: a run that records `output.repoRef` says "this
   * repoRef is indexed", forever, to every reader.
   */
  readonly indexed: boolean;
  /** Would dispatching this same (repo × project) again plausibly succeed? */
  readonly redispatchable: boolean;
  /** One sentence an operator can act on. */
  readonly detail: string;
}

/** What {@link codeGraphIndexDispatchService.bootIndexContainer} returns: either
 *  nothing was provisioned and the dispatch is over, or a container is up and
 *  must be supervised to its end. */
export type IndexBootResult =
  | { phase: 'terminal'; outcome: IndexDispatchOutcome }
  | { phase: 'supervising'; session: IndexSession };

export type IndexDispatchOutcome =
  /** The provider refused to boot the container. No container exists — the port
   *  requires a `provision` that throws to leave none behind. */
  | { outcome: 'provision_failed'; detail: string }
  /**
   * ADMISSION WAS NEVER GRANTED — the caps held for the whole waiting budget
   * (MOTIR-1990). Its own outcome, not folded into `provision_failed`, because
   * nothing was provisioned and nothing about THIS repo is wrong: the fleet was
   * full, for longer than any container may live, which is a fleet fault an
   * operator must see. The run FAILS on it rather than recording a success —
   * §6's ledger contract is what makes "skipped quietly" the unacceptable
   * alternative.
   */
  | { outcome: 'admission_deferred'; reason: IndexAdmissionDeferralReason; detail: string }
  /**
   * THE INDEXER IMAGE COULD NOT BE PULLED — `fleet-image-pull.md` §6.2, split out
   * of `provision_failed` because the remedy is categorically different: nothing
   * about this repo, this tenant or a retry changes anything, a human has to fix
   * the image's visibility, its digest or the mirror, and every queued index hits
   * it identically. The name is what lets an operator read a wall of failures as
   * ONE fault.
   */
  | { outcome: 'image_unpullable'; detail: string }
  /**
   * The container ran and was torn down. `verdict` says what the RUN did;
   * `reason` says how the CONTAINER ended, and they are deliberately separate
   * vocabularies — `TeardownReason` records the fleet's view of a machine, and
   * widening it to carry an indexer diagnosis would make every consumer of that
   * enum learn values it can never observe.
   */
  | {
      outcome: 'settled';
      reason: TeardownReason;
      verdict: IndexExitVerdict;
      containerId: string;
      billableSeconds: number;
      costUsd: string;
      /** The §5 container-seconds record, produced BY the teardown and PERSISTED
       *  by it (MOTIR-1995). Still carried out: this outcome is the durable step's
       *  return value and becomes the run's `job_run` ledger entry, which is a
       *  different record from the queryable cost row — per-run trail vs.
       *  aggregated tenant-attributed cost. */
      usage: ContainerUsage;
      failureDetail: string | null;
    }
  /**
   * Teardown itself failed, so the container may still be running. Reported
   * rather than swallowed, and NOT dressed up as a settled run: the reaper is the
   * backstop that still destroys it.
   */
  | { outcome: 'teardown_failed'; detail: string };

function sleepFor(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : 'unknown';
}

/**
 * How long to wait before poll number `iteration` (1-based).
 *
 * PURE, and a function of the ITERATION rather than of the clock: the durable
 * loop re-derives it on every replay pass, and a wall-clock input would make two
 * passes of the same run schedule different sleeps.
 */
export function indexPollWaitMs(iteration: number, options: IndexSupervisionOptions = {}): number {
  const base = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const cap = options.maxPollIntervalMs ?? MAX_POLL_INTERVAL_MS;
  const grown = base * POLL_BACKOFF_FACTOR ** Math.max(0, iteration - 1);
  return Math.min(Math.max(base, grown), Math.max(base, cap));
}

/**
 * How long to wait before admission attempt number `attempt` (1-based).
 *
 * PURE, and a function of the ATTEMPT rather than of the clock — the same
 * contract {@link indexPollWaitMs} has and for the same reason: the durable loop
 * re-derives every wait on a replay pass, and a wall-clock input would make two
 * passes of one run schedule different sleeps.
 */
export function indexAdmissionWaitMs(
  attempt: number,
  options: IndexSupervisionOptions = {},
): number {
  const base = options.admissionWaitMs ?? ADMISSION_RETRY_BASE_MS;
  const cap = options.maxAdmissionWaitMs ?? ADMISSION_RETRY_MAX_MS;
  const grown = base * ADMISSION_RETRY_FACTOR ** Math.max(0, attempt - 1);
  return Math.min(Math.max(base, grown), Math.max(base, cap));
}

/**
 * The exit code → what happened. The one place the number is interpreted; the
 * port deliberately does not (§4 rule 1 — it makes the code observable and stops
 * there).
 */
export function classifyIndexExit(exitCode: number | null): IndexExitVerdict {
  const verdict = (
    exitClass: IndexExitClass,
    flags: { indexed?: boolean; redispatchable?: boolean },
    detail: string,
  ): IndexExitVerdict => ({
    exitClass,
    exitCode,
    indexed: flags.indexed ?? false,
    redispatchable: flags.redispatchable ?? false,
    detail,
  });

  switch (exitCode) {
    case 0:
      return verdict(
        'indexed',
        { indexed: true },
        'the graph was built, uploaded and its pointer recorded',
      );
    case 10:
      // A dispatcher bug. Re-dispatching sends the same spec and fails the same
      // way, so calling it re-dispatchable would loop on our own defect.
      return verdict(
        'dispatch_malformed',
        {},
        'the container was booted with a missing or blank variable; nothing was attempted',
      );
    case 20:
      // The one class where an immediate re-dispatch is usually right: the
      // pre-signed tarball URL is short-lived by design, and a fresh dispatch
      // resolves a fresh one.
      return verdict(
        'repo_unfetchable',
        { redispatchable: true },
        'the repo could not be obtained — the tarball URL was refused or expired, or the archive was unreadable',
      );
    case 30:
      return verdict(
        'graph_unbuildable',
        {},
        'the source arrived but the engine could not build a graph from it',
      );
    case 40:
      return verdict(
        'upload_failed',
        { redispatchable: true },
        'the graph was built but object storage refused or dropped the upload',
      );
    case 41:
      // Inert rather than corrupting: the snapshot key is derived from the
      // commit, so a retry overwrites the orphaned object.
      return verdict(
        'pointer_unrecorded',
        { redispatchable: true },
        'the graph landed in object storage but motir-ai refused to move the pointer',
      );
    case 50:
      // ⚠️ NEVER RETRY WITH ANOTHER IDENTITY (§4). A refusal is a scope or
      // configuration fault, and re-dispatching with a freshly minted credential
      // would mask exactly the failure the credential boundary exists to make
      // loud.
      return verdict(
        'credential_refused',
        {},
        'the run-scoped credential was refused — expired, or out of scope for the operation attempted; do NOT retry with a broader identity',
      );
    case 137:
      // The kernel killed the process, so nothing in the image's own taxonomy
      // ran. "The machine was too small for this tree" is a different fact from
      // "the engine rejected it", and a retry at the same size repeats it.
      return verdict(
        'out_of_memory',
        {},
        'the kernel OOM-killed the container — the machine was too small for this tree',
      );
    case null:
      // ⚠️ COMMON BY CONSTRUCTION, WHICH IS WHY IT IS NOT RE-DISPATCHABLE. A
      // machine that finishes destroys itself, and a destroyed machine reports no
      // exit code — so a poll that arrives after the exit sees "stopped, code
      // unknown". Treating that as a retry signal would re-index every repo that
      // ever finished between two polls, on a fleet with nothing but Motir's own
      // counter in front of the invoice (§7.2). It is equally not a success:
      // `indexed` stays false, so nothing downstream may claim the repo has a
      // graph.
      return verdict(
        'exit_unobserved',
        {},
        'the container stopped before its exit code could be read; whether it indexed is unknown',
      );
    default:
      return verdict(
        'unclassified',
        {},
        `the container exited ${exitCode}, which the indexer's taxonomy does not name`,
      );
  }
}

/** The verdict for a supervision outcome that is not a container exit at all. */
function supervisionVerdict(
  exitClass: 'never_started' | 'supervision_timed_out',
): IndexExitVerdict {
  return exitClass === 'never_started'
    ? {
        exitClass,
        exitCode: null,
        indexed: false,
        redispatchable: true,
        detail: 'the container was provisioned but never started',
      }
    : {
        exitClass,
        exitCode: null,
        indexed: false,
        redispatchable: true,
        detail: 'supervision gave up on the container before it reported a terminal state',
      };
}

export const codeGraphIndexDispatchService = {
  /**
   * STEP 0 — THE ADMISSION CAP (MOTIR-1990). Ask for a slot; do not boot without
   * one.
   *
   * Bounded by construction: one locked transaction, four counted reads, no
   * external call and no wait — so the step it runs in is milliseconds even when
   * the answer is "wait". THE WAITING IS THE CALLER'S, and deliberately so: a
   * gate that slept inside itself would hold an Inngest invocation open for the
   * duration, which is the shape MOTIR-2007 removed from this fleet. The step
   * driver sleeps with `ctx.step.sleep` (no invocation at all) and asks again;
   * {@link runIndexContainer} does the in-process equivalent.
   *
   * Thin by design — the decision, the lock and every number live in
   * `codeGraphIndexAdmissionService` / `lib/ciFleet/limits.ts`. This is the seam
   * that puts them on the dispatch path, so the job never has to know that a
   * `fleet_in_flight_slot` exists.
   */
  async admitIndexContainer(
    input: IndexDispatchInput,
    options: IndexSupervisionOptions = {},
  ): Promise<IndexAdmissionVerdict> {
    return codeGraphIndexAdmissionService.admit({
      projectId: input.projectId,
      repoRef: input.repoRef,
      workspaceId: input.workspaceId,
      organizationId: input.organizationId,
      // The container's REAL hard kill, which the slot's safety net is derived
      // from. A shorter value would stop counting a container that is still
      // running and spending — the one direction the ceiling must never err in.
      containerTimeoutMs: options.indexTimeoutMs ?? DEFAULT_INDEX_TIMEOUT_MS,
    });
  },

  /**
   * STEP 1 — resolve, mint, boot, and hand back a session.
   *
   * Everything that has to happen exactly once and costs money: the config gate,
   * the run-scoped credential, the pre-signed URL, the container. Bounded by
   * construction — three external calls, no loop, no wait.
   *
   * ⚠️ IT THROWS FOR THE THREE FAILURES THAT ARE NOT ABOUT THIS CONTAINER, and
   * that asymmetry with `ciRunnerBootService.bootIntent` (which never throws for
   * an outcome it can name) is deliberate. There, a throw is a retry that mints a
   * SECOND GitHub runner. Here nothing has been provisioned or registered when
   * any of the three fires, so a throw leaks nothing — and each of them must be
   * loud:
   *
   *   • THE FLEET IS UNCONFIGURED — {@link indexFleetConfig} names every missing
   *     variable at once. A path that quietly returned "nothing to do" would let
   *     the job record a `succeeded` `job_run` carrying an `output.repoRef` for a
   *     repo nothing ever indexed, which is indistinguishable from success
   *     everywhere downstream, forever (§5's ledger constraint).
   *   • THE CREDENTIAL COULD NOT BE MINTED — there is NO fallback. Not
   *     `MOTIR_AI_SERVICE_TOKEN`, not any broader token: motir-ai's
   *     container-facing routes refuse the service token by design
   *     (`ServiceTokenNotAcceptedError`), so reaching for one would be a silent
   *     privilege escalation that the closed layer would then refuse anyway.
   *   • THE TARBALL URL COULD NOT BE RESOLVED — the lenient alternative would be
   *     to buffer a whole repo into this function's heap, which is the OOM (§2:
   *     `motir-core`, 5/5 attempts) that moving indexing onto containers exists
   *     to remove. (The byte-fetching provider method that made that alternative
   *     reachable is gone since MOTIR-2124.)
   *
   *     ⚠️ A HOST THAT CAN *NEVER* RESOLVE ONE SHOULD NOT REACH THIS FUNCTION AT
   *     ALL. Throwing is right for a resolve that FAILED; it is wrong as the
   *     discovery mechanism for a host that structurally cannot, because a throw
   *     here costs five retries and a dead-letter per trigger and explains
   *     nothing. `codeGraphIndexService.resolveIndexTarget` refuses those up
   *     front (`provider_cannot_index`), so what still throws here is a GitHub
   *     repo whose resolve genuinely broke — which IS worth the retry budget.
   *
   * A PROVISION that fails is different in kind — it is about this dispatch, the
   * port guarantees no container was left behind, and its reason is diagnostic —
   * so it comes back as a terminal outcome the ledger can record.
   *
   * ⚠️ `admission` IS REQUIRED, and that is the cap's enforcement (MOTIR-1990).
   * It is the ticket {@link admitIndexContainer} hands back once a
   * `fleet_in_flight_slot` is really taken, so there is no way to reach this
   * function without having been counted — the same compile-time shape the
   * repository layer gets from a non-optional `tx`. NOTHING here re-checks a cap:
   * the decision was made under the lock, and re-deciding outside it would be the
   * TOCTOU the lock exists to close.
   *
   * ⚠️ AND EVERY FAILURE PATH GIVES THE SLOT BACK. A mint that throws, an
   * unresolvable URL, a refused provision — none of them leaves a container
   * behind, so none of them may leave capacity held. Without this the slot would
   * sit until its TTL ages it out, and a deployment failing every boot would
   * silently shrink the fleet to nothing while booting no containers at all.
   */
  async bootIndexContainer(
    input: IndexDispatchInput,
    admission: IndexAdmission,
    options: IndexSupervisionOptions = {},
  ): Promise<IndexBootResult> {
    const now = options.now ?? (() => new Date());
    const indexTimeoutMs = options.indexTimeoutMs ?? DEFAULT_INDEX_TIMEOUT_MS;

    let fleet: IndexFleetConfig;
    let aiBaseUrl: string;
    let orchestrator: ContainerOrchestrator;
    let credential: Awaited<ReturnType<typeof mintCodeGraphRunCredential>>;
    let tarballUrl: string;
    try {
      // ── 0 · The deployment gate, BEFORE anything is spent ──────────────────
      fleet = indexFleetConfig();
      aiBaseUrl = motirAiBaseUrl();
      orchestrator = getOrchestrator();

      // ── 1 · Mint THIS run's motir-ai credential ────────────────────────────
      // Scoped to one (project, repo, run) for minutes, and the only motir-ai
      // credential the container is given.
      credential = await mintCodeGraphRunCredential({
        coreOrganizationId: input.organizationId,
        coreWorkspaceId: input.workspaceId,
        coreProjectId: input.projectId,
        repoRef: input.repoRef,
        runId: input.runId,
      });

      // ── 2 · Resolve the pre-signed tarball URL ─────────────────────────────
      // AFTER the mint, deliberately: the URL is the shorter-lived of the two
      // secrets, so its clock starts as late as possible before the boot. Reached
      // through the REQUIRE helper, which is what turns "this host cannot" into a
      // refusal instead of a fallback to downloading the bytes.
      const resolveTarballUrl = requireRepoTarballUrlResolver(getGitProvider(input.providerId));
      tarballUrl = await resolveTarballUrl(
        input.installationId,
        input.repoOwner,
        input.repoName,
        input.defaultBranch,
      );
    } catch (err) {
      // The three loud failures still throw — the ledger must never record a
      // success for a repo nothing indexed — but the capacity goes back first.
      await codeGraphIndexAdmissionService.release(admission.slotRef);
      throw err;
    }

    // ── 3 · Boot exactly one container ───────────────────────────────────────
    const spec = codeGraphIndexDispatchService.buildIndexSpec({
      target: input,
      fleet,
      aiBaseUrl,
      tarballUrl,
      runCredential: credential.credential,
      timeoutSeconds: Math.ceil(indexTimeoutMs / 1000),
    });

    let handle: ContainerHandle;
    try {
      handle = await orchestrator.provision(spec);
    } catch (err) {
      // The port guarantees a failed `provision` left no container behind, so
      // the slot stands for nothing and is released rather than aged out.
      await codeGraphIndexAdmissionService.release(admission.slotRef);
      if (err instanceof OrchestratorImageUnpullableError) {
        const detail = `the indexer image could not be pulled: ${detailOf(err)}`;
        console.error('[codeGraphIndexDispatchService] the indexer image is not pullable', {
          repoRef: input.repoRef,
          projectId: input.projectId,
          image: err.imageReference,
        });
        return { phase: 'terminal', outcome: { outcome: 'image_unpullable', detail } };
      }
      const detail = `could not boot an index container: ${detailOf(err)}`;
      return { phase: 'terminal', outcome: { outcome: 'provision_failed', detail } };
    }

    return {
      phase: 'supervising',
      session: {
        handle: {
          provider: handle.provider,
          id: handle.id,
          region: handle.region,
          createdAt: handle.createdAt.toISOString(),
        },
        bootedAt: now().toISOString(),
        credentialExpiresAt: credential.expiresAt,
        runId: input.runId,
        repoRef: input.repoRef,
        slotRef: admission.slotRef,
        attribution: {
          orgId: input.organizationId,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          repoFullName: input.repoRef,
        },
      },
    };
  },

  /**
   * STEP 2 (×N) — ONE provider read, and return.
   *
   * Exactly one `describe`, the deadlines applied to what came back, and a
   * return. No loop, no sleep, no second call — so the step it runs in is
   * milliseconds and the constraint cannot silently regress into a long step. The
   * WAITING between polls is `ctx.step.sleep`, which costs no invocation at all.
   *
   * ⚠️ AND IT NEVER THROWS. In a stepped world teardown cannot be reached from a
   * catch — the executor finalizes a terminally-failed step before anything
   * scheduled from a `catch` could run — so the guarantee is structural instead:
   * every failure becomes a typed result, and the only exit is a `done` verdict
   * the caller takes to {@link settleIndexContainer}.
   */
  async pollIndexContainer(
    session: IndexSession,
    previous: Extract<IndexPollResult, { done: false }> = INITIAL_INDEX_POLL_STATE,
    options: IndexSupervisionOptions = {},
  ): Promise<IndexPollResult> {
    const now = options.now ?? (() => new Date());
    const bootDeadlineMs = options.bootDeadlineMs ?? DEFAULT_BOOT_DEADLINE_MS;
    const indexTimeoutMs = options.indexTimeoutMs ?? DEFAULT_INDEX_TIMEOUT_MS;
    const bootedAt = new Date(session.bootedAt).getTime();

    let startedAt = previous.startedAt;

    /** The deadline check BOTH the happy and the failed-read paths fall through
     *  to, so a provider that is down can never extend a container past its
     *  timeout. */
    const deadlineVerdict = (failureDetail: string | null): IndexPollResult | null => {
      const elapsed = now().getTime() - bootedAt;
      if (!startedAt && elapsed >= bootDeadlineMs) {
        return {
          done: true,
          reason: 'provision_failed',
          startedAt: null,
          exitCode: null,
          failureDetail: failureDetail ?? 'the container never started',
        };
      }
      if (elapsed >= indexTimeoutMs) {
        return {
          done: true,
          reason: 'job_timed_out',
          startedAt,
          exitCode: null,
          failureDetail: failureDetail ?? 'the index run outlived its timeout',
        };
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
      // A single provider blip must not end an index that is running fine. The
      // deadlines remain the real bound — this buys the loop the right to MISS a
      // few reads, never the right to run longer.
      const consecutiveReadFailures = previous.consecutiveReadFailures + 1;
      const detail = detailOf(err);
      if (consecutiveReadFailures > MAX_CONSECUTIVE_READ_FAILURES) {
        // Give up on READING, but not on tearing down: a `done` verdict is what
        // routes this to teardown, which is why it returns rather than throws.
        return {
          done: true,
          reason: 'job_timed_out',
          startedAt,
          exitCode: null,
          failureDetail: `the container status could not be read: ${detail}`,
        };
      }
      console.warn('[codeGraphIndexDispatchService] a container status read failed — retrying', {
        containerId: session.handle.id,
        provider: session.handle.provider,
        consecutiveReadFailures,
      });
      return deadlineVerdict(null) ?? { done: false, startedAt, consecutiveReadFailures };
    }

    if (status.startedAt && !startedAt) startedAt = status.startedAt.toISOString();

    // THE CHECKPOINT (MOTIR-1995) — what this container has cost SO FAR, recorded
    // before it stops. Only once it has been seen running: a container that has not
    // started has accrued nothing, and Fly bills a Machine on its RUNNING seconds.
    //
    // ⚠️ IT IS SAFE ON THIS PATH FOR TWO INDEPENDENT REASONS, and both are needed.
    // `recordContainerAccrual` never throws, so it cannot break the never-throws
    // contract above. And the figure it reports is ABSOLUTE-to-date rather than a
    // delta, so a durable step that REPLAYS this poll — the normal case, not an edge
    // one — re-reports the same total and adds nothing. A delta here would have made
    // every replay overstate Motir's own cost, invisibly.
    if (startedAt) {
      await recordContainerAccrual(
        buildContainerAccrual({
          handle: {
            provider: session.handle.provider,
            id: session.handle.id,
            region: session.handle.region,
            createdAt: new Date(session.handle.createdAt),
          },
          attribution: indexUsageAttribution(session),
          createdAt: new Date(session.handle.createdAt),
          startedAt: new Date(startedAt),
          observedAt: now(),
        }),
      );
    }

    if (status.terminal) {
      // Gone or stopped. If it was never seen running, the container is a boot
      // that never happened — a provisioning failure even though the provider
      // reported success.
      const observed = startedAt ?? status.startedAt?.toISOString() ?? null;
      return {
        done: true,
        reason: observed ? 'job_completed' : 'provision_failed',
        startedAt: observed,
        // ⚠️ THE EXIT CODE IS READ HERE OR NOT AT ALL. Once the machine is torn
        // down there is nothing left to ask, and `describe` on a machine that
        // already destroyed itself answers `null` — which is why the poll cadence
        // above is tighter than the CI fleet's.
        exitCode: status.exitCode,
        failureDetail: null,
      };
    }

    return deadlineVerdict(null) ?? { done: false, startedAt, consecutiveReadFailures: 0 };
  },

  /**
   * STEP 3 — THE TEARDOWN, and the only way supervision ends.
   *
   * Destroys the container and classifies what it did. Teardown is what PRODUCES
   * the usage record — the port made that unskippable so a container cannot be
   * destroyed without its cost row existing — and the record rides out on the
   * outcome for MOTIR-1995's meter to persist.
   *
   * ⚠️ AND IT GIVES THE ADMISSION SLOT BACK — but ONLY once the container is
   * really gone (MOTIR-1990). A teardown that FAILED means the container may
   * still be running and still spending, so its slot deliberately stays: it ages
   * out through `expires_at` while the reaper does its work. Releasing there
   * would under-count a live container, which is the one direction the ceiling
   * must never err in. A teardown that had no orchestrator to reach is the same
   * case for the same reason.
   */
  async settleIndexContainer(
    session: IndexSession,
    verdict: Extract<IndexPollResult, { done: true }>,
  ): Promise<IndexDispatchOutcome> {
    const handle: ContainerHandle = {
      provider: session.handle.provider,
      id: session.handle.id,
      region: session.handle.region,
      createdAt: new Date(session.handle.createdAt),
    };
    const observedStartedAt = verdict.startedAt ? new Date(verdict.startedAt) : null;

    let orchestrator: ContainerOrchestrator;
    try {
      orchestrator = orchestratorFor(session);
    } catch (err) {
      console.error('[codeGraphIndexDispatchService] no orchestrator at teardown', {
        containerId: handle.id,
        repoRef: session.repoRef,
      });
      return {
        outcome: 'teardown_failed',
        detail: `no orchestrator at teardown for container ${handle.id}; left for the reaper: ${detailOf(err)}`,
      };
    }

    // ⚠️ THE GUARANTEE. Every path out of supervision arrives here — indexed,
    // failed, never started and unreadable alike. `teardown` is idempotent, so
    // the reaper reaching the same container later is harmless.
    let usage: ContainerUsage;
    try {
      usage = await orchestrator.teardown(
        handle,
        verdict.reason,
        indexUsageAttribution(session, observedStartedAt),
      );
    } catch (err) {
      console.error('[codeGraphIndexDispatchService] could not tear down an index container', {
        containerId: handle.id,
        provider: handle.provider,
        reason: verdict.reason,
      });
      return {
        outcome: 'teardown_failed',
        detail: `teardown failed for container ${handle.id}; left for the reaper: ${detailOf(err)}`,
      };
    }

    // PERSIST THE COST (MOTIR-1995) — the record teardown just produced, RECONCILED
    // against whatever the checkpoints already accrued for this container. It runs
    // after teardown rather than beside it because the container being gone is the
    // property that actually stops the spend; the sink never throws, so a write
    // failure cannot turn "destroyed and unrecorded" into "possibly still running".
    //
    // The record still rides out on the outcome as well. It is not redundant: the
    // outcome is the durable step's return value and lands in the `job_run` ledger
    // as this run's operational trail, while the row this writes is the queryable,
    // aggregated, tenant-attributed one the margin readout reads.
    await recordContainerUsage(usage);

    // AND GIVE THE CAPACITY BACK (MOTIR-1990). After the cost is recorded, so the
    // slot a queued dispatch is about to claim is never freed before the spend it
    // stood for has been written down. The container is provably gone, so the
    // capacity is provably free — which is only true on THIS path: a failed
    // teardown returned above without releasing, because that container may still
    // be running and under-counting a live one is the direction the ceiling must
    // never err in.
    await codeGraphIndexAdmissionService.release(session.slotRef);

    return {
      outcome: 'settled',
      reason: verdict.reason,
      verdict: exitVerdictFor(verdict),
      containerId: handle.id,
      billableSeconds: usage.billableSeconds,
      costUsd: usage.costUsd,
      usage,
      failureDetail: verdict.failureDetail,
    };
  },

  /**
   * The provisioning SPEC for one (repo × project) index run — the port's
   * provider-neutral shape, and the security boundary of the whole feature.
   *
   * ⚠️ PURE: every value arrives as an argument and no environment is read here.
   * That is what lets the test assert the env KEY SET without a deployment, and
   * it is what keeps the four variables the image's boot contract names
   * (`motir-ai/infra/indexer/README.md`) the only four that can be in it.
   *
   * ⚠️ WHAT IS DELIBERATELY ABSENT, since the absence is the decision (§4, §10):
   * no GitHub App key and no installation token — the pre-signed URL is
   * self-authorizing and strictly less privilege; no `DATABASE_URL`; no
   * object-storage credential — motir-ai mints a single-key upload grant instead
   * (§5); no `MOTIR_AI_SERVICE_TOKEN`; and no Fly token, which a container
   * ingesting untrusted source could use to provision in the shared fleet org.
   *
   * ⚠️ AND `FLEET_CONTAINER_SIZE`, NOT A SMALLER INDEX CLASS. The image's
   * measured floor is 2 vCPU / 4096 MB (924 MB peak RSS, 861 MB of it off-heap —
   * MOTIR-1515), which 8192 clears; and it is the only class `CONTAINER_RATES`
   * prices, so a container booted at it is COSTED rather than recorded unpriced.
   * A dedicated 4 GB index class is a rate row someone must add first, which is
   * the meter's call (MOTIR-1995), not this service's.
   */
  buildIndexSpec(args: {
    target: IndexDispatchInput;
    fleet: IndexFleetConfig;
    /** motir-ai's base URL, WITHOUT the service token. */
    aiBaseUrl: string;
    /** The resolved pre-signed, single-repo, short-lived archive URL. */
    tarballUrl: string;
    /** This run's motir-ai credential — opaque, and the only one in the spec. */
    runCredential: string;
    timeoutSeconds: number;
  }): ContainerSpec {
    const { target, fleet, aiBaseUrl, tarballUrl, runCredential, timeoutSeconds } = args;
    return {
      orgId: target.organizationId,
      workspaceId: target.workspaceId,
      projectId: target.projectId,
      repoFullName: target.repoRef,
      workload: CODE_GRAPH_INDEX_WORKLOAD,
      workflowJobId: NO_WORKFLOW_JOB,
      image: fleet.image,
      size: FLEET_CONTAINER_SIZE,
      timeoutSeconds,
      region: fleet.region,
      env: {
        MOTIR_INDEX_TARBALL_URL: tarballUrl,
        MOTIR_INDEX_REPO_REF: target.repoRef,
        MOTIR_AI_BASE_URL: aiBaseUrl,
        MOTIR_INDEX_RUN_CREDENTIAL: runCredential,
      },
    };
  },

  /**
   * Boot ONE index container and supervise it to its end, IN THIS PROCESS.
   *
   * ⚠️ NOT THE PRODUCTION PATH. The job (MOTIR-2027) drives
   * {@link bootIndexContainer} / {@link pollIndexContainer} /
   * {@link settleIndexContainer} as separate durable steps; calling this from a
   * job would rebuild the hour-long invocation MOTIR-2007 removed for CI. It
   * exists for the same reason `ciRunnerBootService.runIntent` does — it is the
   * honest in-process composition of the same three operations, which is what
   * lets the suite drive a whole supervised run at millisecond deadlines — and
   * any caller that is NOT a durable job (a script, a local harness, a test)
   * wants exactly this.
   */
  async runIndexContainer(
    input: IndexDispatchInput,
    options: IndexSupervisionOptions = {},
  ): Promise<IndexDispatchOutcome> {
    const sleep = options.sleep ?? sleepFor;

    // ── 0 · QUEUE FOR ADMISSION — over the cap means WAIT, never drop ─────────
    const admitted = await this.waitForAdmission(input, sleep, options);
    if (admitted.outcome === 'deferred') {
      return {
        outcome: 'admission_deferred',
        reason: admitted.reason,
        detail: admitted.detail,
      };
    }

    const booted = await this.bootIndexContainer(input, admitted.admission, options);
    if (booted.phase === 'terminal') return booted.outcome;

    let state = INITIAL_INDEX_POLL_STATE;
    for (let iteration = 1; iteration <= MAX_POLL_ITERATIONS; iteration += 1) {
      await sleep(indexPollWaitMs(iteration, options));
      const polled = await this.pollIndexContainer(booted.session, state, options);
      if (polled.done) return this.settleIndexContainer(booted.session, polled);
      state = polled;
    }
    // The static ceiling bound. SETTLE rather than abandon: a container nothing
    // tears down is the failure every guarantee here exists to prevent.
    return this.settleIndexContainer(booted.session, {
      done: true,
      reason: 'job_timed_out',
      startedAt: state.startedAt,
      exitCode: null,
      failureDetail: `supervision hit the ${MAX_POLL_ITERATIONS}-poll ceiling`,
    });
  },

  /**
   * Ask for admission until it is granted or the waiting budget runs out — the
   * IN-PROCESS half of "over the cap means WAIT, never drop" (MOTIR-1990).
   *
   * The stepped driver (`lib/jobs/indexFleetSteps.ts`) implements the same loop
   * with `ctx.step.sleep`, which costs no invocation, and that is the production
   * path. This one exists for the same reason {@link runIndexContainer} does —
   * it is the honest in-process composition, and it is what lets a suite drive a
   * genuine over-cap BURST at millisecond waits and watch every repo get through.
   *
   * A `gate_unavailable` deferral is retried like any other: the gate failing
   * closed is a transient it must be allowed to recover from, and refusing to
   * wait on it would turn one bad read into a dropped index — the outcome the
   * whole rule exists to forbid.
   */
  async waitForAdmission(
    input: IndexDispatchInput,
    sleep: (ms: number) => Promise<void>,
    options: IndexSupervisionOptions = {},
  ): Promise<
    | Extract<IndexAdmissionVerdict, { outcome: 'admitted' | 'already_held' }>
    | Extract<IndexAdmissionVerdict, { outcome: 'deferred' }>
  > {
    const attempts = Math.min(
      options.maxAdmissionAttempts ?? MAX_ADMISSION_ATTEMPTS,
      MAX_ADMISSION_ATTEMPTS,
    );
    let last: Extract<IndexAdmissionVerdict, { outcome: 'deferred' }> = {
      outcome: 'deferred',
      reason: 'gate_unavailable',
      detail: 'admission was never attempted',
    };
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const verdict = await this.admitIndexContainer(input, options);
      if (verdict.outcome !== 'deferred') return verdict;
      last = verdict;
      // No wait after the LAST attempt — nothing would observe it.
      if (attempt < attempts) await sleep(indexAdmissionWaitMs(attempt, options));
    }
    return {
      ...last,
      detail: `index admission was refused for ${attempts} attempts (${last.reason}): ${last.detail}`,
    };
  },
};

/** What a `done` verdict means for the RUN, as opposed to for the container. */
function exitVerdictFor(verdict: Extract<IndexPollResult, { done: true }>): IndexExitVerdict {
  if (verdict.reason === 'provision_failed') return supervisionVerdict('never_started');
  if (verdict.reason !== 'job_completed') return supervisionVerdict('supervision_timed_out');
  return classifyIndexExit(verdict.exitCode);
}

/** The orchestrator a session's container lives on. Re-read per step rather than
 *  carried across the boundary: an adapter is not serializable, and the handle is
 *  — which is exactly why the port made it opaque. */
function orchestratorFor(_session: IndexSession): ContainerOrchestrator {
  return getOrchestrator();
}
