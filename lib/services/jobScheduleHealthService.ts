import { withSystemContext } from '@/lib/workspaces/context';
import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import { jobSchedules } from '@/lib/jobs/schedules';
import { previousFireAtOrBefore } from '@/lib/jobs/cron';
import type { ScheduleHealthEntryDTO, ScheduleHealthReportDTO } from '@/lib/dto/jobSchedules';

// THE DETECTION SEAM for a stale Inngest app registry (MOTIR-1970).
//
// The failure it exists to catch is silent by construction. When the Inngest
// cloud app's registered function list falls behind the deployed build, events
// for the un-registered functions are ACCEPTED and then consumed by nothing:
// `inngest.send()` succeeds, no run is created, no `job_run` row is written, no
// error is raised anywhere. A dead job is indistinguishable from a job nobody
// triggered. Production ran that way from 2026-07-02 to 2026-08-01 — five jobs
// dead for a month, every feature built on them shipping "green".
//
// CRON JOBS ARE THE TRIPWIRE, and they are the only honest one. An
// event-triggered job that has never run may simply never have been triggered,
// so its silence proves nothing. A cron job has no such excuse: Inngest owes it
// a tick on a schedule we can compute, so "no run since the tick before last"
// is unambiguous. And because a stale registry strands EVERY function added
// after the last sync, the crons among them are a sufficient sample — the
// registry does not go stale one function at a time.
//
// WHY THE CHECKER SURVIVES THE FAULT. `system.daily-health-check` is one of the
// oldest jobs in the registry (2026-06-01), so it is registered in every sync a
// stale app could be holding. That is the property that makes this work: an OLD
// job checking on NEW ones. A checker added alongside the jobs it watches would
// be stranded by the same stale sync and would never run to report anything.
// KEEP IT THERE — do not move this check into a newly-defined job.
//
// WHY THIS DOES NOT IMPORT THE REGISTRY. `jobSchedules()` only holds jobs whose
// definition module has been evaluated, so completeness looks like it should be
// guaranteed by importing `lib/jobs/registry` here — but that import is a cycle
// (registry → definitions/dailyHealthCheck → this service → registry), and an
// ESM cycle would leave the `jobServices` bag half-built at module-eval time.
// The guarantee comes from two cycle-free places instead: at RUNTIME nothing can
// invoke a handler without `app/api/inngest/route.ts` having imported the
// registry first, so the table is always complete by the time `check()` runs;
// and at BUILD time `tests/jobs/schedule-health.test.ts` imports the registry
// and asserts the table covers every cron job in `jobFunctions`, so a new cron
// job that somehow escaped registration fails CI.
//
// TOLERANCE. A job is judged against the fire BEFORE the most recent one, so
// exactly one missed tick is forgiven. That is period-relative by construction:
// an hourly job gets ~2 hours, a monthly job gets ~2 months, with no per-job
// staleness constant to keep in sync. One tick of slack absorbs a deploy window
// or a transient Inngest delay; two consecutive misses is a real fault.

/** Decide one scheduled job's verdict against `now`. */
function judge(
  functionId: string,
  cron: string,
  lastRunAt: Date | null,
  now: Date,
): { entry: ScheduleHealthEntryDTO; overdue: boolean } {
  const mostRecentFire = previousFireAtOrBefore(cron, now);
  // The tick before the most recent one — the deadline the job is held to.
  const judgedAgainst =
    mostRecentFire === null
      ? null
      : previousFireAtOrBefore(cron, new Date(mostRecentFire.getTime() - 60_000));

  const entry: ScheduleHealthEntryDTO = {
    functionId,
    cron,
    lastRunAt: lastRunAt?.toISOString() ?? null,
    judgedAgainst: judgedAgainst?.toISOString() ?? null,
  };

  // No second fire inside the horizon means the schedule is too young (or too
  // sparse) to have owed two ticks yet. Report it, judge it clear — flagging a
  // job that was never due would make the whole report noise.
  if (judgedAgainst === null) return { entry, overdue: false };
  return { entry, overdue: lastRunAt === null || lastRunAt < judgedAgainst };
}

export const jobScheduleHealthService = {
  /**
   * Check every registered cron job against the ledger.
   *
   * `now` is injectable so the test can pin a moment rather than race the wall
   * clock — the same reason the CI-minutes services take one.
   */
  async check(now: Date = new Date()): Promise<ScheduleHealthReportDTO> {
    const schedules = jobSchedules();
    // The ledger records a cron run under the synthetic `scheduled.{id}` event
    // name (see `defineJob`), so that is the key the aggregate groups on.
    const eventNameFor = (functionId: string) => `scheduled.${functionId}`;

    // One aggregate for the whole table — including when it is empty, which
    // Prisma answers with no rows rather than needing a guard here.
    const rows = await withSystemContext((tx) =>
      jobRunRepository.findLatestStartedAtByEventNames(
        schedules.map((s) => eventNameFor(s.functionId)),
        tx,
      ),
    );
    const latestByEventName = new Map(rows.map((row) => [row.eventName, row.latestStartedAt]));

    const entries: ScheduleHealthEntryDTO[] = [];
    const overdue: ScheduleHealthEntryDTO[] = [];
    for (const { functionId, cron } of schedules) {
      const verdict = judge(
        functionId,
        cron,
        latestByEventName.get(eventNameFor(functionId)) ?? null,
        now,
      );
      entries.push(verdict.entry);
      if (verdict.overdue) overdue.push(verdict.entry);
    }

    return { checkedAt: now.toISOString(), entries, overdue };
  },
};
