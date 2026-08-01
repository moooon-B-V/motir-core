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

/** Every scheduled job registered so far, sorted by id for a stable report. */
export function jobSchedules(): ReadonlyArray<{ functionId: string; cron: string }> {
  return [...schedules.entries()]
    .map(([functionId, cron]) => ({ functionId, cron }))
    .sort((a, b) => a.functionId.localeCompare(b.functionId));
}
