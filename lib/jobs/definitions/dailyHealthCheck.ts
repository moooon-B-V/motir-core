import { defineJob } from '../defineJob';

// The canonical SCHEDULED job (Story 1.6 · Subtask 1.6.4) — the reference for
// the cron primitive, and the replacement for the 1.6.2 `system.ping` smoke
// job. Runs daily at 09:00 via Inngest's cron trigger, so there is no separate
// scheduler service to operate.
//
// It is a deliberate no-op: its job is to prove the scheduled path end-to-end
// (cron → defineJob wrapper → a `job_run` row whose `event_name` is the
// synthetic `scheduled.system.daily-health-check`), and to be the worked
// example docs/jobs.md → "Scheduled jobs" points at. A real health check would
// add probes here and surface failures via the DLQ like any other job.
//
// `retryPolicy: 'none'` (run at most once): a health check is a point-in-time
// probe — retrying it minutes later would record a stale verdict, so a failed
// tick should dead-letter immediately rather than retry.

/** The fixed payload the health check resolves to. Exported for the test. */
export const DAILY_HEALTH_CHECK_PAYLOAD = { ok: true, check: 'daily-health-check' } as const;

/** The cron expression — 09:00 every day. Exported so the test asserts wiring. */
export const DAILY_HEALTH_CHECK_CRON = '0 9 * * *';

export const dailyHealthCheck = defineJob(
  { id: 'system.daily-health-check', cron: DAILY_HEALTH_CHECK_CRON, retryPolicy: 'none' },
  () => {
    return DAILY_HEALTH_CHECK_PAYLOAD;
  },
);
