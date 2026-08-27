import { JOB_ENGINE_JOBS_ENV, JOB_ENGINE_JOBS_FILE_ENV, routedJobIds } from './cutover';

// THE LANE CENSUS, AND THE RECONCILIATION AGAINST THE LIVE SECRET
// (Bug MOTIR-3716; the census itself is MOTIR-3682's, moved here from its test).
//
// ===========================================================================
// WHY THE DECLARATION LIVES IN SHIPPED CODE AND NOT IN THE TEST THAT ASSERTS IT
// ===========================================================================
// The census began as two `const`s inside
// `tests/jobs/every-job-declares-its-lane.test.ts`, and as a build-time guard it
// worked exactly as designed: a job cannot join the registry without somebody
// naming its lane, because the test goes red on the pull request that adds it.
//
// What a test file cannot do is be READ BY THE RUNNING PROCESS. So the half of
// the operation a pull request can carry — the DECLARATION — was closed
// completely, while the half only an operator can carry — the DEPLOYMENT, a
// `fly secrets set` on `MOTIR_POSTGRES_JOB_IDS` — stayed exactly as unowned as
// it had been. Four jobs drifted in ~34 hours (MOTIR-3682, MOTIR-3688,
// MOTIR-3709), each found by a person running `comm` by hand, and the fourth was
// declared correctly in the very pull request that added it.
//
// ⚠️ THE FAILURE DIRECTION IS THE EXPENSIVE ONE. A drifted job does not lose its
// lane; it runs on the WRONG one, and every code-side signal reads green:
// `scheduler.ts` skips it (`!routedToEngine(def.id)` → no timer) while
// `defineJob`'s Inngest guard does NOT skip it (`routedToEngine(id)` is false →
// the handler runs). So it runs daily, apparently fine, while a reviewed file
// says it runs on the engine — and the bill arrives when MOTIR-3418 deletes the
// SDK and the job silently loses its subscriber.
//
// Moving the lists here costs one import in the test and makes the declaration
// something a PROCESS can compare against the secret. That comparison is
// `reconcileLanes()` below, and it is the only thing that has ever been able to
// see this fault without a human deciding to go and look.
//
// ===========================================================================
// ⚠️ IT REPORTS. IT NEVER REFUSES.
// ===========================================================================
// The deploy window in which the code is ahead of the secret is REQUIRED, not
// tolerated: routing an id whose job is not in the running image routes it
// NOWHERE (`docs/jobs.md`'s image trap — `fly secrets set` restarts the machines
// on the CURRENT release, not on `main`). So the correct order is always
// deploy-then-route, and for those minutes a declared-but-not-routed difference
// is the system working. A check that turned that window into a boot failure
// would convert a routine release into an outage.
//
// Hence the split, and it is deliberate rather than a matter of taste:
//
//   * `logLaneReconciliation()` — the WORKER's start-up report. Warns, loudly,
//     and cannot throw. The worker is the process that would silently stop
//     running a drifted job, so it is the cheapest place to say so.
//   * `system.daily-health-check` — the LOUD one, a whole day later, where a
//     non-empty difference dead-letters and its message lands on the operator
//     dashboard's DLQ tab. A difference that has survived until 09:00 the next
//     morning is not a deploy window.
//
// ===========================================================================
// This file has a KNOWN END, exactly as `cutover.ts` does
// ===========================================================================
// MOTIR-3418 deletes the second lane. When there is no lane to route between,
// there is nothing to declare and nothing to reconcile, and this file goes with
// `cutover.ts`. Saying so here is the same discipline that file states for
// itself: a migration mechanism with no stated end becomes a permanent one.

/**
 * Jobs intended to run on the Postgres engine. Kept equal to the production
 * secret `MOTIR_POSTGRES_JOB_IDS` — BY HAND at the moment of the edit, and by
 * {@link reconcileLanes} from then on.
 *
 * ⚠️ TO FIX A CENSUS FAILURE: add the id here or to
 * {@link DELIBERATELY_ON_INNGEST}. Do not delete the assertion. Adding it here
 * is HALF the change — the other half is `fly secrets set`, and the whole point
 * of the reconciliation below is that the two halves are now compared.
 */
export const MIGRATED_TO_ENGINE = [
  'automation-engine/commented',
  'automation-engine/created',
  'automation-engine/field.changed',
  'automation-engine/transitioned',
  'email.send',
  'filter-subscription/deliver',
  'notification-fan-in/comment.created',
  'notification-fan-in/mentioned',
  'notification-fan-in/transitioned',
  'outward-bug-telemetry/created',
  'plan-drift/transitioned',
  'public-follow/digest',
  'status-derivation/child-set-changed',
  'status-derivation/created',
  'status-derivation/requested',
  'status-derivation/transitioned',
  'system.abandoned-plan-sweep',
  'system.attachment-gc',
  'system.auto-plan-cadence-tick',
  'system.automation-retention-sweep',
  'system.billing-seat-sync',
  'system.ci-actions-gate-sweep',
  'system.ci-minutes-reconcile',
  'system.ci-runner-boot',
  'system.ci-runner-provision-sweep',
  'system.ci-runner-reap',
  'system.code-graph-index',
  'system.code-graph-offboard-sweep',
  'system.code-graph-refresh',
  'system.daily-health-check',
  'system.filter-subscription-tick',
  'system.job-run-reap',
  'system.migrate-onboarding-sweep',
  'system.plan-target-lock-sweep',
  'system.public-follow-digest-tick',
  'system.rate-limit-sweep',
  'watcher-notify/comment.created',
  'watcher-notify/transitioned',
  'work-item/comment.created',
  'work-item/embedding.requested',
  'work-item/mentioned',
] as const;

/**
 * Jobs deliberately still on Inngest, each with the card that owns moving it.
 * An entry here is a DECISION, not a backlog: it says somebody looked.
 *
 * This list going EMPTY is the condition MOTIR-3418 (_"Retire Inngest"_) is
 * premised on, and the honest way to check that premise.
 */
export const DELIBERATELY_ON_INNGEST: ReadonlyArray<{ id: string; because: string }> = [
  // ⚠️ EMPTY, AND THAT IS A RESULT — not a list nobody has filled in yet.
  //
  // The three container supervisors (`system.code-graph-index`,
  // `system.code-graph-refresh`, `system.ci-runner-boot`) were the last entries
  // and moved to {@link MIGRATED_TO_ENGINE} above with MOTIR-3489, which is the
  // card that also carried the operator half — the `fly secrets set` that puts
  // the same three ids into `MOTIR_POSTGRES_JOB_IDS`.
  //
  // This list being empty is the condition MOTIR-3418 (_"Retire Inngest"_) is
  // premised on: NOTHING is deliberately left on the old lane. It is the honest
  // way to check that premise, and the assertion in
  // `tests/jobs/lane-reconciliation.test.ts` now states it positively — every
  // registered job is declared for the engine — rather than sampling `[0]`.
  //
  // ⚠️ AN ENTRY HERE IS STILL LEGAL, and re-adding one is not a regression: a
  // job that must stay on Inngest belongs here WITH ITS REASON rather than
  // undeclared. What the emptiness records is that on 2026-08-27 no such job
  // existed. Nothing about the list's SHAPE changed; only its contents.
];

/** The declared engine set, as a set. The left-hand side of the reconciliation. */
export function declaredEngineJobIds(): ReadonlySet<string> {
  return new Set<string>(MIGRATED_TO_ENGINE);
}

/** The ids declared as deliberately staying on Inngest, as a set. */
export function declaredInngestJobIds(): ReadonlySet<string> {
  return new Set(DELIBERATELY_ON_INNGEST.map((e) => e.id));
}

/**
 * What comparing the checked-in declaration against the live routing set found.
 *
 * A discriminated union rather than a boolean, for the reason
 * `FleetBootableVerdict` is one: "could not tell" and "nothing to tell" are
 * different answers from "clean", and a reader of a `job_run` row needs to be
 * able to tell them apart. In particular {@link LaneNotCutOver} is NOT folded
 * into {@link LaneNotApplicable} — an UNCONFIGURED deployment reading as
 * "nothing to see here" is the exact shape this whole card is about.
 */
export type LaneReconciliation = LaneInSync | LaneDrifted | LaneNotCutOver | LaneNotApplicable;

/** The declared set and the routed set are equal. The assertable green state. */
export interface LaneInSync {
  readonly verdict: 'in_sync';
  /** How many ids agreed. Recorded so a green row is readable as a measurement. */
  readonly routed: number;
}

/** The two sets differ. Both directions are reported, always, and separately. */
export interface LaneDrifted {
  readonly verdict: 'drifted';
  /**
   * Declared for the engine, ABSENT from the live secret — the job runs on
   * Inngest while a reviewed file says it does not. The four measured instances
   * were all this direction, and it is the silent one.
   */
  readonly declaredNotRouted: readonly string[];
  /**
   * Routed by the secret, NOT declared for the engine — production is ahead of
   * review. A typo in the secret, an id whose job was renamed or deleted, or a
   * job somebody moved without shipping the declaration. Reported separately
   * because a one-way check reproduces this very defect in the other direction.
   */
  readonly routedNotDeclared: readonly string[];
}

/**
 * Nothing is routed at all. Every job runs on Inngest, which is the switch's
 * safety default and a legitimate steady state for a deployment that has not
 * cut over.
 *
 * ⚠️ ITS OWN ARM, NOT `not_applicable`. It is quiet — a self-hosted install must
 * not dead-letter daily over a migration it never started — but it is NAMED, so
 * a reader of the ledger can tell _unconfigured_ from _nothing to check_. Those
 * two reading alike is how an unset variable becomes invisible.
 */
export interface LaneNotCutOver {
  readonly verdict: 'not_cut_over';
  /** How many ids the declaration would route, once somebody sets the secret. */
  readonly declared: number;
  readonly detail: string;
}

/** There is no deployment to reconcile against — the test-only file override is armed. */
export interface LaneNotApplicable {
  readonly verdict: 'not_applicable';
  readonly detail: string;
}

/**
 * Compare the checked-in declaration against the live routing set.
 *
 * Pure, synchronous, and free: it reads a module constant and one environment
 * variable, so it costs nothing to call at start-up and nothing to call daily.
 * Never throws — every arm is an answer, and the CALLER decides which arms are
 * loud (the same contract `fleetPreflightService` states for its own probe).
 */
export function reconcileLanes(): LaneReconciliation {
  // The file override is a TEST-ONLY channel (`cutover.ts` refuses it in
  // production outright). When it is armed, the routed set is a spec's fixture
  // that moves mid-run, and comparing a fixture to the census would report drift
  // on every E2E boot. Checked FIRST, because the file wins over the env var in
  // `routedJobIds()` and the verdict must describe the value actually in force.
  const overridePath = process.env[JOB_ENGINE_JOBS_FILE_ENV];
  if (overridePath !== undefined && overridePath !== '') {
    return {
      verdict: 'not_applicable',
      detail: `${JOB_ENGINE_JOBS_FILE_ENV} is armed (${overridePath}); the routed set is a test fixture, not a deployment`,
    };
  }

  const declared = declaredEngineJobIds();
  const routed = routedJobIds();

  if (routed.size === 0) {
    return {
      verdict: 'not_cut_over',
      declared: declared.size,
      detail:
        `${JOB_ENGINE_JOBS_ENV} names no jobs, so every job runs on Inngest — the cutover ` +
        `switch's safety default. ${declared.size} job(s) are declared for the engine and would ` +
        `move the moment the secret is set.`,
    };
  }

  const declaredNotRouted = [...declared].filter((id) => !routed.has(id)).sort();
  const routedNotDeclared = [...routed].filter((id) => !declared.has(id)).sort();

  if (declaredNotRouted.length === 0 && routedNotDeclared.length === 0) {
    return { verdict: 'in_sync', routed: routed.size };
  }

  return { verdict: 'drifted', declaredNotRouted, routedNotDeclared };
}

/**
 * The operator-readable sentence for a drift, in the register the DLQ row and
 * the worker log both need: WHICH ids, WHICH direction, and what to do.
 *
 * The message is the whole of what a human reads — `dailyHealthCheck.ts` states
 * that at length about its own errors — so both directions are named even when
 * one of them is empty, because "and nothing in the other direction" is itself
 * the reassurance a reader is looking for.
 */
export function describeLaneDrift(drift: LaneDrifted): string {
  const declaredNotRouted =
    drift.declaredNotRouted.length > 0
      ? `${drift.declaredNotRouted.length} job(s) are DECLARED for the engine but ABSENT from ` +
        `${JOB_ENGINE_JOBS_ENV}, so they are running on Inngest while the repository says they ` +
        `are not: ${drift.declaredNotRouted.join(', ')}. Add them to the secret ` +
        `(read-modify-write — read it immediately before you write it).`
      : `Nothing is declared-but-not-routed.`;

  const routedNotDeclared =
    drift.routedNotDeclared.length > 0
      ? `${drift.routedNotDeclared.length} id(s) are ROUTED by ${JOB_ENGINE_JOBS_ENV} but not ` +
        `declared in MIGRATED_TO_ENGINE, so production is ahead of review (or the id is a typo, ` +
        `or names a job that has been renamed or deleted): ${drift.routedNotDeclared.join(', ')}. ` +
        `Ship the declaration, or remove the id from the secret.`
      : `Nothing is routed-but-not-declared.`;

  return (
    `The job LANE declaration and the live routing secret disagree. ${declaredNotRouted} ` +
    `${routedNotDeclared} ` +
    `See docs/jobs.md § "Cutting a job over to the Postgres engine".`
  );
}

/** One line summarising any verdict, for a log sink that wants a string. */
export function describeLaneReconciliation(result: LaneReconciliation): string {
  switch (result.verdict) {
    case 'in_sync':
      return `lane declaration and ${JOB_ENGINE_JOBS_ENV} agree on all ${result.routed} routed job(s)`;
    case 'drifted':
      return describeLaneDrift(result);
    case 'not_cut_over':
      return result.detail;
    case 'not_applicable':
      return result.detail;
  }
}

/** The minimum a logger must offer. `console` satisfies it; so does a spy. */
export type LaneReconciliationLogger = Pick<Console, 'info' | 'warn'>;

/**
 * ⚠️ THE START-UP REPORT, AND IT CANNOT THROW.
 *
 * Called by `scripts/worker.ts` once the registry is evaluated. A drift is
 * WARNed and start-up continues, because the ordinary deploy window has the code
 * ahead of the secret by construction and refusing to boot there would turn a
 * routine release into an outage. The loud surface is a whole day later, in
 * `system.daily-health-check`, by which time a difference is no longer a deploy
 * window.
 *
 * Returns the verdict so a caller (and the test) can assert on it; the return
 * value is otherwise unused.
 */
export function logLaneReconciliation(log: LaneReconciliationLogger = console): LaneReconciliation {
  const result = reconcileLanes();
  const line = `[job-lanes] ${describeLaneReconciliation(result)}`;
  if (result.verdict === 'drifted') log.warn(line);
  else log.info(line);
  return result;
}
