import { jobEventRepository } from '@/lib/repositories/jobEventRepository';
import { jobQueueRepository } from '@/lib/repositories/jobQueueRepository';
import { jobStepRepository } from '@/lib/repositories/jobStepRepository';
import {
  JOB_QUEUE_PURGE_BATCH_SIZE,
  JOB_QUEUE_PURGE_MAX_BATCHES,
  JOB_QUEUE_RETENTION_MS,
} from '@/lib/services/jobRunsService';
import { withSystemContext } from '@/lib/workspaces/context';

// THE QUEUE RETENTION PASS (Story MOTIR-8540) — the engine's queue tables stop
// growing without bound.
//
// Nothing deleted a `job_queue` row, so every run the engine ever finished was
// still there (~266k succeeded rows), with its `job_step` memo and its
// `job_event`. MOTIR-6935 bounded the LEDGER (`job_run`); this bounds the queue
// beside it, with the same shape: a window, a batch size, one short transaction
// per batch, and a cap on batches so a backlog drains over several days.
//
// WHAT IT NEVER DELETES is the whole design, and it lives in the repository's
// predicates, not here: only `succeeded` rows past the window, never the newest
// `scheduled_for` row of a job (the scheduler's catch-up watermark), and only
// events no queue row of any state still references.
// `docs/decisions/job-queue-retention-readers.md` lists every reader that rule
// protects; `docs/decisions/job-queue-foundation.md` §17 records what the window
// does to the queue's dedup keys.

/** What one pass removed, per table — the job stores it as the run's `output`. */
export interface JobQueueRetentionReport {
  jobQueue: number;
  jobStep: number;
  jobEvent: number;
  /** Transactions run, across both phases. */
  batches: number;
  /** True when BOTH phases ran out of rows before the batch cap. */
  drained: boolean;
}

export const jobQueueRetentionService = {
  /**
   * Delete expired succeeded runs with their steps, then the events they leave
   * orphaned. Each batch is its own `withSystemContext` transaction (system rows
   * carry no workspace, so only the system context sees them all).
   *
   * Phase 2 runs after phase 1, so an event whose last run was deleted in this
   * pass goes in the same pass. A short batch means that phase is drained.
   * Converges: a deleted row stops matching, so a missed or repeated fire is free.
   */
  async purgeExpired(
    opts: { now?: Date; retentionMs?: number; batchSize?: number; maxBatches?: number } = {},
  ): Promise<JobQueueRetentionReport> {
    const now = opts.now ?? new Date();
    const retentionMs = opts.retentionMs ?? JOB_QUEUE_RETENTION_MS;
    const batchSize = opts.batchSize ?? JOB_QUEUE_PURGE_BATCH_SIZE;
    const maxBatches = opts.maxBatches ?? JOB_QUEUE_PURGE_MAX_BATCHES;
    const cutoff = new Date(now.getTime() - retentionMs);

    const report: JobQueueRetentionReport = {
      jobQueue: 0,
      jobStep: 0,
      jobEvent: 0,
      batches: 0,
      drained: false,
    };

    // Phase 1 — succeeded runs past the window, steps first. `job_step.run_id`
    // cascades, so the explicit delete is redundant today; it is what makes the
    // step count reportable, and keeps the pass right if the cascade ever goes.
    let queueDrained = false;
    for (let i = 0; i < maxBatches; i += 1) {
      const found = await withSystemContext(async (tx) => {
        const ids = await jobQueueRepository.findPurgeableSucceededIds(cutoff, batchSize, tx);
        if (ids.length === 0) return 0;
        report.jobStep += await jobStepRepository.deleteByRuns(ids, tx);
        report.jobQueue += await jobQueueRepository.deleteSucceededByIds(ids, tx);
        return ids.length;
      });
      report.batches += 1;
      if (found < batchSize) {
        queueDrained = true;
        break;
      }
    }

    // Phase 2 — events past the window that nothing references any more.
    let eventsDrained = false;
    for (let i = 0; i < maxBatches; i += 1) {
      const removed = await withSystemContext((tx) =>
        jobEventRepository.deleteOrphanedOlderThan(cutoff, batchSize, tx),
      );
      report.jobEvent += removed;
      report.batches += 1;
      if (removed < batchSize) {
        eventsDrained = true;
        break;
      }
    }

    report.drained = queueDrained && eventsDrained;
    return report;
  },
};
