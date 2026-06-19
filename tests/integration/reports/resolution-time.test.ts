import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { reportsService } from '@/lib/services/reportsService';
import { InvalidReportWindowError } from '@/lib/reports/errors';
import { bucketKey, type ReportPeriod } from '@/lib/reports/buckets';
import { makeWorkItemFixture, createTestWorkItem } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';
import type { Prisma } from '@prisma/client';

// Story 8.8 · Subtask 8.8.13 — reportsService.getResolutionTime. Real Postgres,
// the created-vs-resolved conventions: a SEEDED 1.4.6 revision trail of
// transitions INTO a done-category status at known offsets from "now". Each
// bucket (keyed by resolution date) is the average of (resolvedAt − createdAt)
// in days over the resolutions in that bucket; an event-less bucket is null
// ("—"), and windowAverage is the mean of the non-null bucket averages.

const DAY_MS = 24 * 60 * 60 * 1000;
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}
async function addRevision(
  workItemId: string,
  changedById: string,
  changedAt: Date,
  diff: Prisma.InputJsonValue,
): Promise<void> {
  await db.workItemRevision.create({
    data: { workItemId, changedById, changeKind: 'updated', changedAt, diff },
  });
}
async function setCreatedAt(id: string, createdAt: Date): Promise<void> {
  await db.workItem.update({ where: { id }, data: { createdAt } });
}
const toDone = { status: { from: 'todo', to: 'done' } };
const reopen = { status: { from: 'done', to: 'todo' } };

function bucketOf(buckets: Array<{ date: string }>, period: ReportPeriod, d: Date) {
  return (buckets as Array<{ date: string; avgDays: number | null; count: number }>).find(
    (b) => b.date === bucketKey(period, d),
  )!;
}

beforeEach(async () => {
  await truncateAuthTables();
});
afterAll(async () => {
  await db.$disconnect();
});

async function expectOk(promise: ReturnType<typeof reportsService.getResolutionTime>) {
  const result = await promise;
  expect(result.state).toBe('ok');
  if (result.state !== 'ok') throw new Error('unreachable');
  return result.data;
}

describe('getResolutionTime — the bucket matrix', () => {
  it('averages (resolvedAt − createdAt) per resolution bucket, null on event-less buckets', async () => {
    const fx = await makeWorkItemFixture();
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A' });
    const b = await createTestWorkItem(fx, { kind: 'task', title: 'B' });
    const c = await createTestWorkItem(fx, { kind: 'task', title: 'C' });
    await setCreatedAt(a.id, daysAgo(10));
    await setCreatedAt(b.id, daysAgo(6));
    await setCreatedAt(c.id, daysAgo(5));
    // A + B resolve in the SAME bucket (2 days ago): ages 8 and 4 → avg 6.
    await addRevision(a.id, fx.ownerId, daysAgo(2), toDone);
    await addRevision(b.id, fx.ownerId, daysAgo(2), toDone);
    // C resolves today: age 5.
    await addRevision(c.id, fx.ownerId, daysAgo(0), toDone);

    const data = await expectOk(
      reportsService.getResolutionTime(
        { projectId: fx.projectId },
        { period: 'day', daysBack: 5 },
        fx.ctx,
      ),
    );

    expect(data.buckets).toHaveLength(5);
    expect(bucketOf(data.buckets, 'day', daysAgo(2))).toMatchObject({ avgDays: 6, count: 2 });
    expect(bucketOf(data.buckets, 'day', daysAgo(0))).toMatchObject({ avgDays: 5, count: 1 });
    expect(bucketOf(data.buckets, 'day', daysAgo(3))).toMatchObject({ avgDays: null, count: 0 });
    // windowAverage = mean of the non-null bucket averages: (6 + 5) / 2 = 5.5.
    expect(data.windowAverage).toBe(5.5);
  });

  it('counts each transition INTO done — a reopened-then-redone item resolves twice', async () => {
    const fx = await makeWorkItemFixture();
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A' });
    await setCreatedAt(a.id, daysAgo(4));
    await addRevision(a.id, fx.ownerId, daysAgo(3), toDone); // age 1, bucket -3
    await addRevision(a.id, fx.ownerId, daysAgo(2), reopen); // not a resolution
    await addRevision(a.id, fx.ownerId, daysAgo(1), toDone); // age 3, bucket -1

    const data = await expectOk(
      reportsService.getResolutionTime(
        { projectId: fx.projectId },
        { period: 'day', daysBack: 5 },
        fx.ctx,
      ),
    );
    expect(bucketOf(data.buckets, 'day', daysAgo(3))).toMatchObject({ avgDays: 1, count: 1 });
    expect(bucketOf(data.buckets, 'day', daysAgo(1))).toMatchObject({ avgDays: 3, count: 1 });
  });

  it('excludes archived items and is null/empty windowAverage when nothing resolved', async () => {
    const fx = await makeWorkItemFixture();
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A' });
    await setCreatedAt(a.id, daysAgo(4));
    await addRevision(a.id, fx.ownerId, daysAgo(1), toDone);
    await db.workItem.update({ where: { id: a.id }, data: { archivedAt: new Date() } });

    const data = await expectOk(
      reportsService.getResolutionTime(
        { projectId: fx.projectId },
        { period: 'day', daysBack: 5 },
        fx.ctx,
      ),
    );
    expect(data.buckets.every((b) => b.avgDays === null)).toBe(true);
    expect(data.windowAverage).toBeNull();
  });

  it('throws the typed 422 on an over-long daily window', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      reportsService.getResolutionTime(
        { projectId: fx.projectId },
        { period: 'day', daysBack: 200 },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidReportWindowError);
  });
});
