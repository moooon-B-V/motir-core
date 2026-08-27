// The SCHEDULE TABLE (MOTIR-1970) — every cron job's id paired with its cron
// expression, populated by `defineJob` itself as each definition module loads.
//
// WHY IT SELF-REGISTERS. The schedule-health check needs to iterate the cron
// jobs, and every other way of getting that list can drift from reality: a
// hand-maintained array is a second source of truth that a new job forgets to
// join, and reading the crons back off the built Inngest function objects means
// reaching into SDK internals that an upgrade can rename. Registering from
// inside `defineJob` makes the table complete BY CONSTRUCTION — a job cannot
// declare a cron without appearing here, which is exactly the property the
// check depends on.
//
// COMPLETENESS DEPENDS ON IMPORT. The table only holds jobs whose definition
// module has been evaluated. `lib/jobs/registry.ts` imports all of them, so any
// consumer MUST import the registry before reading this — `jobScheduleHealth
// Service` does, deliberately and with a comment saying why.

import { parseCron } from './cron';

const schedules = new Map<string, string>();

/**
 * Record that `id` is a cron job on `cron`. Called by `defineJob`; not part of
 * the public job-authoring surface. Idempotent — a re-registration under the
 * same id (module re-evaluation under HMR or a test harness) overwrites rather
 * than duplicating.
 */
export function registerSchedule(id: string, cron: string): void {
  schedules.set(id, cron);
}

/** One row of the schedule table: a scheduled job's id and its cron expression. */
export interface JobSchedule {
  functionId: string;
  cron: string;
}

/** Every scheduled job registered so far, sorted by id for a stable report. */
export function jobSchedules(): ReadonlyArray<JobSchedule> {
  return [...schedules.entries()]
    .map(([functionId, cron]) => ({ functionId, cron }))
    .sort((a, b) => a.functionId.localeCompare(b.functionId));
}

// ─────────────────────────────────────────────────────────────────────────────
// THE CLUSTER INVARIANT (MOTIR-3314) — the schedule's SHAPE is what costs money
//
// Motir's Postgres suspends when idle, and the only quantity billed is how often
// it WAKES. Every tick of every job here is a guaranteed database WRITE, not a
// possible read: `defineJob` records a `job_run` row BEFORE the handler body runs
// and flips it after, so no early return in any handler avoids the wake. That
// makes the cost a property of the SET of schedules rather than of any one of
// them — N jobs on N distinct minutes wake the compute N times; the same N jobs
// aligned onto shared minutes wake it once.
//
// So the schedules are CLUSTERED onto `SCHEDULE_CLUSTER_MINUTES`, and what is
// defended below is the resulting QUIET GAP — the stretches of the hour in which
// nothing fires. That is a property no single job's comment can protect:
// the next person adding a scheduled job picks a free-looking minute, for exactly
// the load-spreading reasons that are correct on an always-on machine, and
// quietly re-opens the gap. Nothing fails, nothing alerts, and the bill returns
// months later with no diff to blame. Hence an assertion rather than a convention
// — `tests/jobs/schedule-cluster.test.ts` walks this table and fails the build.
//
// The measurement behind the numbers is `docs/decisions/application-hosting.md`
// §21; the per-job trade each cadence made is in that job's own definition.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The minutes past the hour every `system.*` cron is allowed to fire on.
 *
 * Two slots rather than one because the daily table-walking sweeps genuinely
 * should not share a cold start, and two slots let them be separated by HOUR
 * while still landing on a clustered minute — separation that costs no extra
 * wake. A job needing finer granularity than 30 minutes is a decision to bring
 * back to §21, not a minute to pick.
 */
export const SCHEDULE_CLUSTER_MINUTES: ReadonlyArray<number> = [0, 30];

/**
 * The floor the quiet gap may not drop below, in minutes.
 *
 * Priced against the SUSPEND DELAY, not against a documented setting: the delay
 * observed on 2026-08-20 was ~9 min, and the same method on a sibling endpoint
 * three days later gave ~5m12s (§21). It is a reading with a date on it, not a
 * threshold Neon contracts to — which is precisely why this is 30 rather than a
 * tight fit above 9. `motir-gateway` reached the same 30-minute spacing by the
 * same argument (MOTIR-3411), after 10-minute spacing cleared the then-believed
 * threshold by about a minute and cost a 77% duty cycle.
 */
export const MIN_QUIET_GAP_MINUTES = 30;

/**
 * Every minute past the hour on which SOME registered schedule can fire, sorted.
 *
 * Deliberately reads the MINUTE field alone and ignores hour / day / month: a
 * daily job at 04:45 opens minute 45 as a wake-minute on the day it fires, and a
 * gap that only holds on the other 364 days is not a gap. Conservative in the
 * only direction that is safe to be.
 */
export function wakeMinutes(schedules: ReadonlyArray<JobSchedule> = jobSchedules()): number[] {
  const minutes = new Set<number>();
  for (const { cron } of schedules) {
    for (const minute of parseCron(cron).minute) minutes.add(minute);
  }
  return [...minutes].sort((a, b) => a - b);
}

/**
 * Every gap between consecutive wake-minutes, in minutes, over one hour.
 *
 * Cyclic: the last wake-minute's gap wraps to the first of the next hour, which
 * is the stretch a compute actually gets to sleep in. An EMPTY table has no wake
 * at all, so the single gap is the whole 60 minutes.
 */
function wakeGapsMinutes(schedules: ReadonlyArray<JobSchedule>): number[] {
  const minutes = wakeMinutes(schedules);
  if (minutes.length === 0) return [60];
  return minutes.map((minute, i) =>
    i === minutes.length - 1 ? minutes[0]! + 60 - minute : minutes[i + 1]! - minute,
  );
}

/**
 * The LONGEST stretch of an hour in which no schedule fires.
 *
 * The number this schedule is discussed in, and the one directly comparable to
 * MOTIR-2853's finding that the old shape left a longest gap of 7 minutes against
 * a ~9 min suspend delay. Reported, quoted in §21 — and NOT the thing asserted;
 * `shortestWakeGapMinutes` is. See the warning on that function.
 */
export function longestQuietGapMinutes(
  schedules: ReadonlyArray<JobSchedule> = jobSchedules(),
): number {
  return Math.max(...wakeGapsMinutes(schedules));
}

/**
 * The SHORTEST gap between two consecutive wake-minutes — THE INVARIANT.
 *
 * ⚠️ WHY THIS AND NOT THE LONGEST GAP, WHICH IS THE NUMBER EVERYTHING ELSE
 * QUOTES. Because the longest gap does not defend the bill, and the test that
 * demonstrates it is in `tests/jobs/schedule-cluster.test.ts`. Add one job at :17
 * to a `{0, 30}` schedule and the minutes become `{0, 17, 30}`: the :17 job
 * splits ONE of the two half-hours, the OTHER is untouched, so the longest gap is
 * still 30 and a longest-gap assertion passes. The compute meanwhile stops
 * sleeping in the first half-hour entirely — duty cycle roughly doubles, for one
 * added job, under a green test.
 *
 * The economics are why: a compute sleeps in a gap only for the part of it
 * exceeding the suspend delay, so total awake time is driven by EVERY gap, and
 * the SMALLEST one is the binding constraint. A schedule is only as clustered as
 * its tightest pair.
 *
 * (MOTIR-3314's acceptance criterion asks for "the longest gap … fail if it drops
 * below the target". That wording is right for DIAGNOSING the old shape — 7
 * minutes was the honest summary of a set with no gap wide enough to sleep in —
 * and wrong as a guard, for the reason above. Both are computed; the reading is
 * reported and the invariant is asserted.)
 */
export function shortestWakeGapMinutes(
  schedules: ReadonlyArray<JobSchedule> = jobSchedules(),
): number {
  return Math.min(...wakeGapsMinutes(schedules));
}
