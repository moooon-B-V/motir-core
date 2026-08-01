import { defineJob } from '../defineJob';
import type { ScheduleHealthReportDTO } from '@/lib/dto/jobSchedules';

// The canonical SCHEDULED job (Story 1.6 · Subtask 1.6.4) — the reference for
// the cron primitive, and the replacement for the 1.6.2 `system.ping` smoke
// job. Runs daily at 09:00 via Inngest's cron trigger, so there is no separate
// scheduler service to operate. It is still the worked example docs/jobs.md →
// "Scheduled jobs" points at, and still proves the scheduled path end-to-end
// (cron → defineJob wrapper → a `job_run` row whose `event_name` is the
// synthetic `scheduled.system.daily-health-check`).
//
// It began as a deliberate no-op. As of MOTIR-1970 it carries a real probe: the
// SCHEDULE-HEALTH CHECK, which fails the run when a cron job has stopped firing.
// That is the detection seam for a stale Inngest app registry — the fault where
// the cloud's registered function list falls behind the deployed build, so
// events for newer functions are accepted and consumed by nothing, in complete
// silence. `jobScheduleHealthService` carries the full reasoning; the part that
// matters HERE is why the probe lives in THIS job and not a new one:
//
//   this job is old (2026-06-01), so it is registered in any stale sync the
//   cloud could still be holding. A checker defined alongside the jobs it
//   watches would be stranded by the very fault it exists to report.
//
// Do not move the probe to a newer job, and do not re-declare this one under a
// new id — either would re-open the blind spot.
//
// `retryPolicy: 'none'` (run at most once): a health check is a point-in-time
// probe — retrying it minutes later would record a stale verdict, so a failed
// tick dead-letters immediately rather than retrying. That is also what makes
// the failure LOUD: the DLQ tab of the 1.6.5 operator dashboard gets a row
// naming every overdue job, instead of a queue that quietly consumes nothing.

/** The cron expression — 09:00 every day. Exported so the test asserts wiring. */
export const DAILY_HEALTH_CHECK_CRON = '0 9 * * *';

/** What the job resolves to on a healthy tick — persisted on the `job_run` row. */
export interface DailyHealthCheckResult {
  ok: true;
  check: 'daily-health-check';
  schedules: ScheduleHealthReportDTO;
}

/** The stable half of the resolved payload. Exported for the test. */
export const DAILY_HEALTH_CHECK_PAYLOAD = { ok: true, check: 'daily-health-check' } as const;

/**
 * Thrown when at least one cron job has missed more than one consecutive tick.
 * Its message names the offenders because that message is what lands in the DLQ
 * row's `failure` — an operator should not have to open a database to learn
 * WHICH job stopped.
 */
export class ScheduledJobsOverdueError extends Error {
  constructor(readonly report: ScheduleHealthReportDTO) {
    const detail = report.overdue
      .map((e) => `${e.functionId} (cron ${e.cron}; last run ${e.lastRunAt ?? 'never'})`)
      .join(', ');
    super(
      `${report.overdue.length} scheduled job(s) have not run since their previous tick: ${detail}. ` +
        `Suspect a stale Inngest app registration — re-sync with PUT /api/inngest and check that the ` +
        `sync is happening on deploy (MOTIR-1970).`,
    );
    this.name = 'ScheduledJobsOverdueError';
  }
}

export const dailyHealthCheck = defineJob(
  { id: 'system.daily-health-check', cron: DAILY_HEALTH_CHECK_CRON, retryPolicy: 'none' },
  async (ctx, services): Promise<DailyHealthCheckResult> => {
    // `step.run` memoizes the read, so the verdict is captured once per run
    // rather than re-derived on every replay of the handler body.
    const schedules = await ctx.step.run('schedule-health', () =>
      services.jobScheduleHealth.check(),
    );

    // This job's own ledger row is written by `recordStart` BEFORE the handler
    // body runs, so the check always sees a fresh run for
    // `system.daily-health-check` itself and can never flag itself as overdue.
    if (schedules.overdue.length > 0) throw new ScheduledJobsOverdueError(schedules);

    return { ...DAILY_HEALTH_CHECK_PAYLOAD, schedules };
  },
);
