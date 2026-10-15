import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { engineJob } from '@/lib/jobs/engine/registry';
import { jobServices } from '@/lib/jobs/services';
import { JOB_QUEUE_RETENTION_CRON } from '@/lib/jobs/definitions/jobQueueRetention';
import { jobEventRepository } from '@/lib/repositories/jobEventRepository';
import { jobQueueRepository } from '@/lib/repositories/jobQueueRepository';
import { jobStepRepository } from '@/lib/repositories/jobStepRepository';
import { jobQueueRetentionService } from '@/lib/services/jobQueueRetentionService';
import { JOB_QUEUE_RETENTION_MS } from '@/lib/services/jobRunsService';
import '@/lib/jobs/registry';

// Story MOTIR-8540 · Subtask MOTIR-8585 — the LOOP contract of the queue
// retention pass, with the three repositories spied: the cutoff it derives, the
// order of the deletes inside a batch, the batch cap, the drain verdict and the
// per-table report. Which rows the predicates keep is the real-database test's
// (`job-queue-retention.test.ts`); the transactions here are real but empty.

const NOW = new Date('2026-10-14T06:15:00Z');

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

/** `findPurgeableSucceededIds` answering from a fixed backlog, `limit` at a time. */
function backlog(total: number): void {
  let left = total;
  let next = 0;
  vi.spyOn(jobQueueRepository, 'findPurgeableSucceededIds').mockImplementation(
    async (_cutoff, limit) => {
      const n = Math.min(limit, left);
      left -= n;
      return Array.from({ length: n }, () => `run-${(next += 1)}`);
    },
  );
}

describe('jobQueueRetentionService.purgeExpired (MOTIR-8585)', () => {
  it('deletes steps before runs in each batch, then orphaned events, and reports per table', async () => {
    const order: string[] = [];
    backlog(3);
    vi.spyOn(jobStepRepository, 'deleteByRuns').mockImplementation(async (ids) => {
      order.push(`steps:${ids.length}`);
      return ids.length * 2;
    });
    vi.spyOn(jobQueueRepository, 'deleteSucceededByIds').mockImplementation(async (ids) => {
      order.push(`runs:${ids.length}`);
      return ids.length;
    });
    const events = vi
      .spyOn(jobEventRepository, 'deleteOrphanedOlderThan')
      .mockImplementation(async () => {
        order.push('events');
        return 4;
      });

    const report = await jobQueueRetentionService.purgeExpired({ now: NOW, batchSize: 10 });

    expect(order).toEqual(['steps:3', 'runs:3', 'events']);
    expect(report).toEqual({ jobQueue: 3, jobStep: 6, jobEvent: 4, batches: 2, drained: true });
    // The cutoff is `now − JOB_QUEUE_RETENTION_MS`, for both phases.
    const cutoff = new Date(NOW.getTime() - JOB_QUEUE_RETENTION_MS);
    expect(vi.mocked(jobQueueRepository.findPurgeableSucceededIds).mock.calls[0]![0]).toEqual(
      cutoff,
    );
    expect(events.mock.calls[0]![0]).toEqual(cutoff);
  });

  it('stops at maxBatches and reports not drained, so a backlog drains over several passes', async () => {
    backlog(25);
    const runs = vi
      .spyOn(jobQueueRepository, 'deleteSucceededByIds')
      .mockImplementation(async (ids) => ids.length);
    vi.spyOn(jobStepRepository, 'deleteByRuns').mockResolvedValue(0);
    vi.spyOn(jobEventRepository, 'deleteOrphanedOlderThan').mockResolvedValue(10);

    const first = await jobQueueRetentionService.purgeExpired({
      now: NOW,
      batchSize: 10,
      maxBatches: 2,
    });

    expect(first).toMatchObject({ jobQueue: 20, jobEvent: 20, batches: 4, drained: false });
    expect(runs.mock.calls.map(([ids]) => ids.length)).toEqual([10, 10]);
  });

  it('skips the deletes when a batch finds nothing', async () => {
    backlog(0);
    const steps = vi.spyOn(jobStepRepository, 'deleteByRuns');
    const runs = vi.spyOn(jobQueueRepository, 'deleteSucceededByIds');
    vi.spyOn(jobEventRepository, 'deleteOrphanedOlderThan').mockResolvedValue(0);

    const report = await jobQueueRetentionService.purgeExpired({ now: NOW });

    expect(steps).not.toHaveBeenCalled();
    expect(runs).not.toHaveBeenCalled();
    expect(report).toEqual({ jobQueue: 0, jobStep: 0, jobEvent: 0, batches: 2, drained: true });
  });
});

describe('system.job-queue-retention (MOTIR-8585)', () => {
  it('is registered daily at 06:15 with catch-up latest and returns the pass report', async () => {
    const registered = engineJob('system.job-queue-retention');
    expect(registered).toMatchObject({ cron: JOB_QUEUE_RETENTION_CRON, catchUp: 'latest' });
    expect(JOB_QUEUE_RETENTION_CRON).toBe('15 6 * * *');

    const report = { jobQueue: 7, jobStep: 9, jobEvent: 2, batches: 3, drained: true };
    vi.spyOn(jobServices.jobQueueRetention, 'purgeExpired').mockResolvedValue(report);
    const silentStep = { run: async (_id: string, fn: () => unknown) => fn() };

    const result = await registered!.handler({ step: silentStep } as never, jobServices as never);

    expect(result).toEqual(report);
  });
});
