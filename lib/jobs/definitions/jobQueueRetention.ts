import { defineJob } from '../defineJob';

// THE QUEUE RETENTION PASS (Story MOTIR-8540) — deletes succeeded `job_queue`
// rows past the window, their `job_step` memo, and the `job_event` rows they
// leave orphaned. The keep-rules live with the repository's predicates and the
// loop with `jobQueueRetentionService.purgeExpired`; this file is only the tick.
//
// `retryPolicy: 'idempotent'`: the pass converges by construction. A deleted row
// stops matching, and a batch is its own transaction, so a retry after a partial
// pass simply carries on from where the last committed batch left it.

/**
 * Daily, at 06:15 UTC. Beside the `job_run` retention it mirrors
 * (`system.job-run-reap`, 06:00) and before `system.dispatch-run-sweep` (06:30):
 * the slot is otherwise empty, and it is after the 03:00–05:30 housekeeping band.
 *
 * `catchUp: 'latest'` (§11.4): the candidate set is defined by elapsed time
 * (`created_at < now − 30d`), so one pass sees everything every missed pass
 * would have, and replaying is free because a deleted row stops matching. What a
 * skipped fire costs is another day of growth in the tables this exists to bound.
 */
export const JOB_QUEUE_RETENTION_CRON = '15 6 * * *';

export const jobQueueRetention = defineJob(
  {
    id: 'system.job-queue-retention',
    cron: JOB_QUEUE_RETENTION_CRON,
    catchUp: 'latest',
    retryPolicy: 'idempotent',
  },
  async (ctx, services) =>
    // The per-table counts land on the ledger row's `output`, which is what makes
    // the pass readable on the job runs table rather than only in a log.
    ctx.step.run('purge-expired-job-queue', () => services.jobQueueRetention.purgeExpired()),
);
