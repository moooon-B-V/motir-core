import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { JobRunState } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { jobEventRepository } from '@/lib/repositories/jobEventRepository';
import { jobQueueRepository } from '@/lib/repositories/jobQueueRepository';
import { jobStepRepository } from '@/lib/repositories/jobStepRepository';
import { JOB_QUEUE_RETENTION_MS } from '@/lib/services/jobRunsService';
import { withSystemContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateJobRuns } from '../helpers/db';

// Story MOTIR-8540 · Subtask MOTIR-8584 — a SMOKE test of the four data-layer
// methods the queue retention pass is built from: each runs under the system
// context and returns the expected count for a three-row seed. The behaviour
// matrix (what survives, the watermark, dedup inside the window, the drain) is
// `job-queue-retention.test.ts`'s.

const NOW = new Date('2026-10-14T06:00:00Z');
const CUTOFF = new Date(NOW.getTime() - JOB_QUEUE_RETENTION_MS);
const OLD = new Date(CUTOFF.getTime() - 24 * 60 * 60 * 1000);
const YOUNG = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);

beforeEach(async () => {
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedRun(
  id: string,
  state: JobRunState,
  createdAt: Date,
  opts: { eventId?: string; scheduledFor?: Date } = {},
): Promise<void> {
  await adminDb.jobQueueRun.create({
    data: {
      id,
      jobId: 'test.retention-smoke',
      eventName: 'test/retention-smoke',
      eventId: opts.eventId ?? null,
      scheduledFor: opts.scheduledFor ?? null,
      runAt: createdAt,
      maxAttempts: 3,
      state,
      createdAt,
    },
  });
}

describe('job_queue retention — repository methods (MOTIR-8584)', () => {
  it('findPurgeableSucceededIds returns the old succeeded row and nothing live, young or newest-scheduled', async () => {
    await seedRun('old-done', 'succeeded', OLD, { scheduledFor: OLD });
    await seedRun('old-done-newest', 'succeeded', OLD, {
      scheduledFor: new Date(OLD.getTime() + 60_000),
    });
    await seedRun('old-failed', 'failed', OLD);
    await seedRun('young-done', 'succeeded', YOUNG);

    const ids = await withSystemContext((tx) =>
      jobQueueRepository.findPurgeableSucceededIds(CUTOFF, 10, tx),
    );

    expect(ids).toEqual(['old-done']);
  });

  it('deleteSucceededByIds deletes only rows still succeeded, and an empty list is a no-op', async () => {
    await seedRun('done', 'succeeded', OLD);
    await seedRun('pending', 'pending', OLD);
    await seedRun('failed', 'failed', OLD);

    const deleted = await withSystemContext((tx) =>
      jobQueueRepository.deleteSucceededByIds(['done', 'pending', 'failed'], tx),
    );
    const none = await withSystemContext((tx) => jobQueueRepository.deleteSucceededByIds([], tx));

    expect(deleted).toBe(1);
    expect(none).toBe(0);
    const left = await adminDb.jobQueueRun.findMany({
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    expect(left.map((r) => r.id)).toEqual(['failed', 'pending']);
  });

  it("deleteByRuns deletes the listed runs' steps and no other run's, and an empty list is a no-op", async () => {
    await seedRun('run-a', 'succeeded', OLD);
    await seedRun('run-b', 'succeeded', OLD);
    await seedRun('run-c', 'succeeded', OLD);
    for (const runId of ['run-a', 'run-b', 'run-c']) {
      await adminDb.jobStep.create({
        data: { runId, stepId: 's1', kind: 'run', result: {} },
      });
    }

    const deleted = await withSystemContext((tx) =>
      jobStepRepository.deleteByRuns(['run-a', 'run-b'], tx),
    );
    const none = await withSystemContext((tx) => jobStepRepository.deleteByRuns([], tx));

    expect(deleted).toBe(2);
    expect(none).toBe(0);
    const left = await adminDb.jobStep.findMany({ select: { runId: true } });
    expect(left.map((r) => r.runId)).toEqual(['run-c']);
  });

  it('deleteOrphanedOlderThan deletes old orphans only, and never a referenced event', async () => {
    await adminDb.jobEvent.createMany({
      data: [
        { id: 'ev-orphan-old', name: 'test/e', data: {}, receivedAt: OLD },
        { id: 'ev-orphan-young', name: 'test/e', data: {}, receivedAt: YOUNG },
        { id: 'ev-referenced-old', name: 'test/e', data: {}, receivedAt: OLD },
      ],
    });
    await seedRun('failed-ref', 'failed', OLD, { eventId: 'ev-referenced-old' });

    const deleted = await withSystemContext((tx) =>
      jobEventRepository.deleteOrphanedOlderThan(CUTOFF, 10, tx),
    );

    expect(deleted).toBe(1);
    const left = await adminDb.jobEvent.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
    expect(left.map((r) => r.id)).toEqual(['ev-orphan-young', 'ev-referenced-old']);
  });
});
