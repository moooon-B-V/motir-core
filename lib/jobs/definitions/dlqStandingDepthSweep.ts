import { defineJob } from '../defineJob';

// The DLQ STANDING-DEPTH sweep (MOTIR-5869) — the clock behind
// `dlqStandingDepthService.sweep`, which files ONE `bug` per job function whose
// dead letters have stood undisposed for more than seven days. The policy — the
// age predicate, the dedup row, the re-arm-only-on-zero rule, who files — is all
// in the service; this file is the SCHEDULE.
//
// ⚠️ A DEDICATED JOB, NOT A CHECK INSIDE `system.daily-health-check`. That job is
// itself in `job_run_dlq` 35 times: an alarm that dead-letters into the queue it
// watches has already failed (MOTIR-3606, MOTIR-4918). As its own job, this
// sweep's terminal failure is an EVENT the event path catches, while the event
// path's blind spot — standing state — is what this catches. Neither watches
// itself.
//
// System-scoped: `job_run_dlq` is deployment-wide, so the sweep reads under
// `withSystemContext` and its ledger row is untenanted, like every `system.*` job.
//
// `retryPolicy: 'idempotent'`: a re-run converges by construction — a filed
// function is disarmed under a row lock, so a retry after a partial failure files
// only the functions that did not file.

/** 07:00 every day — a clustered minute (`SCHEDULE_CLUSTER_MINUTES`), so it opens
 *  no new wake-minute, and an hour of its own after the nightly cascade
 *  (03:00 → 06:30). Daily is ample for a SEVEN-day threshold: a function crosses
 *  it at most a day before it is filed. */
export const DLQ_STANDING_DEPTH_SWEEP_CRON = '0 7 * * *';

export const dlqStandingDepthSweep = defineJob(
  {
    id: 'system.dlq-standing-depth-sweep',
    cron: DLQ_STANDING_DEPTH_SWEEP_CRON,
    // `latest`: the predicate is AGE over a standing table, so one run sees
    // everything every missed run would have, and a missed day only delays a
    // filing whose threshold is a week.
    catchUp: 'latest',
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    return ctx.step.run('sweep-standing-dead-letters', () => services.dlqStandingDepth.sweep());
  },
);
