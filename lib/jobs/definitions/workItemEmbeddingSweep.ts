import { defineJob } from '../defineJob';

// The work-item embedding sweep (Story MOTIR-8226 · Subtask MOTIR-8227) — hourly
// re-embed of every live work item whose vector is missing or stale. The event
// path (`work-item/embedding.requested`) embeds on create and edit; this is the
// net under it for jobs that were lost. What it scans, bounds and isolates lives
// in `workItemEmbeddingSweepService`.
//
// System-scoped (it walks every tenant's projects), so the id is `system.*` and the
// ledger row is untenanted. `retryPolicy: 'idempotent'`: every write is "embed this
// text under this hash", so a re-run finds the finished items current and skips
// them, and a missed hour is caught up by the next.

/** Minute 17 of every hour. Only SUB-hourly crons are pinned to the five-minute
 *  grid (MOTIR-6893); an hourly one may sit on any minute, and off :00 keeps it
 *  clear of the top-of-hour pile. */
export const WORK_ITEM_EMBEDDING_SWEEP_CRON = '17 * * * *';

export const workItemEmbeddingSweep = defineJob(
  {
    id: 'system.work-item-embedding-sweep',
    cron: WORK_ITEM_EMBEDDING_SWEEP_CRON,
    catchUp: 'latest',
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    return ctx.step.run('embed-stale-work-items', () => services.workItemEmbeddingSweep.sweep());
  },
);
