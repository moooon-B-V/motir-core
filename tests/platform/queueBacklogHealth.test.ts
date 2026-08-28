import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as queueHealthRoute } from '@/app/api/health/queue/route';
import { db } from '@/lib/db';
import { platformHealthService } from '@/lib/services/platformHealthService';
import { adminDb } from '../helpers/adminDb';
import { truncateJobRuns } from '../helpers/db';

/**
 * THE QUEUE BACKLOG READING (Subtask MOTIR-3764), against a real Postgres.
 *
 * ⚠️ THE PROPERTY UNDER TEST IS THAT NOBODY HAS TO ASK THE ENGINE. On 2026-08-28
 * the queue stopped being claimed at 10:15:16 and the only thing that noticed was
 * a person wondering why six work items had not moved — because the check that
 * would have reported it is itself a job, and a wedged worker takes the alarm
 * down with the thing it is meant to alarm on. So every assertion here drives the
 * real read against real rows, and none of them enqueues anything or waits on a
 * run.
 *
 * ⚠️ AND AGE IS THE VERDICT, DEPTH IS THE CONTEXT. The two cases that matter are
 * the ones a depth threshold gets backwards: a DEEP queue that is draining is
 * healthy, and a SHALLOW one that has not moved is not. Both are asserted below,
 * and a check written on depth alone fails one of them.
 */

let seq = 0;

async function enqueueDue(agoMs: number): Promise<string> {
  seq += 1;
  const row = await adminDb.jobQueueRun.create({
    data: {
      jobId: `queue.health.${seq}`,
      eventName: 'test.event',
      workspaceId: null,
      runAt: new Date(Date.now() - agoMs),
      maxAttempts: 3,
    },
  });
  return row.id;
}

beforeEach(async () => {
  await truncateJobRuns();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the reading itself', () => {
  it('counts the DUE backlog and ages the oldest of it', async () => {
    await enqueueDue(30_000);
    await enqueueDue(90_000);
    await enqueueDue(10_000);

    const queue = await platformHealthService.readQueueHealth();

    expect(queue.depth).toBe(3);
    // The OLDEST, not the newest and not an average — it is the number that ended
    // the 2026-08-28 investigation in about thirty seconds.
    expect(queue.oldestPendingAgeMs).toBeGreaterThanOrEqual(90_000);
    expect(queue.oldestPendingAgeMs).toBeLessThan(120_000);
  });

  it('counts only what a worker could claim RIGHT NOW', async () => {
    const due = await enqueueDue(5_000);
    // Scheduled for later — pending, and not waiting on a worker.
    await adminDb.jobQueueRun.create({
      data: {
        jobId: 'queue.health.future',
        eventName: 'test.event',
        workspaceId: null,
        runAt: new Date(Date.now() + 60 * 60_000),
        maxAttempts: 3,
      },
    });
    // Already claimed — in flight, not waiting.
    const claimed = await enqueueDue(5_000);
    await adminDb.jobQueueRun.update({
      where: { id: claimed },
      data: { state: 'running', claimedBy: 'w', leaseExpiresAt: new Date(Date.now() + 60_000) },
    });

    const queue = await platformHealthService.readQueueHealth();

    expect(queue.depth).toBe(1);
    expect(await adminDb.jobQueueRun.count()).toBe(3); // all three rows exist
    expect(due).toBeTruthy();
  });

  it('an EMPTY queue is HEALTHY, with a null age and no error', async () => {
    const queue = await platformHealthService.readQueueHealth();

    expect(queue).toMatchObject({ state: 'healthy', depth: 0, oldestPendingAgeMs: null });
    // ⚠️ `null`, not `0`. A measured empty queue and an unread probe must not
    // render as the same number — the rule `platformHealthService`'s own header
    // exists to keep, applied to the age.
    expect(queue.oldestPendingAgeMs).not.toBe(0);
  });

  it('READS ONLY — it enqueues nothing and depends on no run', async () => {
    await enqueueDue(1_000);
    const before = await adminDb.jobQueueRun.findMany({ orderBy: { id: 'asc' } });

    await platformHealthService.readQueueHealth();
    await platformHealthService.readQueueHealth();

    const after = await adminDb.jobQueueRun.findMany({ orderBy: { id: 'asc' } });
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after.map((r) => r.state)).toEqual(before.map((r) => r.state));
    expect(after.map((r) => r.attempts)).toEqual(before.map((r) => r.attempts));
    // And no ledger row appeared — this is not a job and never runs as one.
    expect(await adminDb.jobRun.count()).toBe(0);
  });
});

describe('AGE decides, not DEPTH', () => {
  it('a DEEP queue that is moving is HEALTHY', async () => {
    for (let i = 0; i < 50; i += 1) await enqueueDue(2_000);

    const queue = await platformHealthService.readQueueHealth();

    expect(queue.depth).toBe(50);
    expect(queue.state).toBe('healthy');
  });

  it('a SHALLOW queue that has STALLED is not', async () => {
    await enqueueDue(20 * 60_000); // one row, twenty minutes unclaimed

    const queue = await platformHealthService.readQueueHealth();

    expect(queue.depth).toBe(1);
    expect(queue.state).toBe('stalled');
    // The threshold travels with the verdict, so a reader never has to guess
    // what "stalled" meant on the day it fired.
    expect(queue.oldestPendingAgeMs).toBeGreaterThan(queue.stallThresholdMs);
  });

  it('the threshold is generous enough that ordinary latency cannot reach it', async () => {
    // The worker's idle poll ceiling is 5s and a NOTIFY normally beats it, so a
    // due row waiting a minute is slow, not stalled.
    await enqueueDue(60_000);

    const queue = await platformHealthService.readQueueHealth();

    expect(queue.state).toBe('healthy');
    expect(queue.stallThresholdMs).toBe(5 * 60 * 1000);
  });
});

describe('the route an external monitor polls', () => {
  it('answers 200 and no-store while the queue is moving', async () => {
    await enqueueDue(1_000);

    const res = await queueHealthRoute();

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['state']).toBe('healthy');
    expect(body['depth']).toBe(1);
  });

  it('answers 503 on a stall, so a monitor reading only the STATUS still works', async () => {
    await enqueueDue(20 * 60_000);

    const res = await queueHealthRoute();

    expect(res.status).toBe(503);
    expect(((await res.json()) as Record<string, unknown>)['state']).toBe('stalled');
  });

  it('carries NO tenant data — which is what makes it safe to leave ungated', async () => {
    await enqueueDue(1_000);

    const body = (await (await queueHealthRoute()).json()) as Record<string, unknown>;

    // The whole payload, asserted as a SET rather than by absence of a few names:
    // a field added later cannot slip through a `not.toHaveProperty` list.
    expect(Object.keys(body).sort()).toEqual(
      ['checkedAt', 'depth', 'oldestPendingAgeMs', 'stallThresholdMs', 'state'].sort(),
    );
  });

  it('an UNREADABLE database is a 503, never a healthy-looking zero', async () => {
    vi.spyOn(platformHealthService, 'readQueueHealth').mockRejectedValue(new Error('down'));

    const res = await queueHealthRoute();

    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['state']).toBe('unreadable');
    // ⚠️ NOT a depth of zero. That substitution is the exact failure the
    // platform-health board's own header exists to prevent, and a machine reader
    // has no operator to notice it.
    expect(body).not.toHaveProperty('depth');
  });
});
