import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { reportsService } from '@/lib/services/reportsService';
import { InvalidReportWindowError } from '@/lib/reports/errors';
import { bucketKey, type ReportPeriod } from '@/lib/reports/buckets';
import { makeWorkItemFixture, createTestWorkItem } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';
import type { Prisma } from '@prisma/client';

// Story 8.8 · Subtask 8.8.13 — reportsService.getAverageAge. Real Postgres. A
// POINT-IN-TIME read: for each bucket's period-end instant, the average age in
// days of issues created by then and not yet resolved at that instant (the
// resolution point is the first transition INTO a done-category status in the
// 1.4.6 trail). The LATEST bucket's period-end is "now" (capped), so its age is
// exact (now − createdAt); earlier buckets close on a UTC midnight boundary, so
// the matrix asserts the now-anchored latest bucket + the open/resolved
// population, never a midnight-sensitive exact value.

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

function latestBucket(buckets: Array<{ date: string; avgDays: number | null; count: number }>) {
  const key = bucketKey('day' as ReportPeriod, new Date());
  return buckets.find((b) => b.date === key)!;
}

beforeEach(async () => {
  await truncateAuthTables();
});
afterAll(async () => {
  await db.$disconnect();
});

async function expectOk(promise: ReturnType<typeof reportsService.getAverageAge>) {
  const result = await promise;
  expect(result.state).toBe('ok');
  if (result.state !== 'ok') throw new Error('unreachable');
  return result.data;
}

describe('getAverageAge — the point-in-time matrix', () => {
  it('averages (now − createdAt) over still-open items in the latest bucket; resolved items drop out', async () => {
    const fx = await makeWorkItemFixture();
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A' });
    const b = await createTestWorkItem(fx, { kind: 'task', title: 'B' });
    const c = await createTestWorkItem(fx, { kind: 'task', title: 'C' });
    await setCreatedAt(a.id, daysAgo(10)); // open → age 10 at now
    await setCreatedAt(b.id, daysAgo(4)); // open → age 4 at now
    await setCreatedAt(c.id, daysAgo(8)); // resolved 3 days ago → excluded at now
    await addRevision(c.id, fx.ownerId, daysAgo(3), toDone);

    const data = await expectOk(
      reportsService.getAverageAge(
        { projectId: fx.projectId },
        { period: 'day', daysBack: 5 },
        fx.ctx,
      ),
    );

    const latest = latestBucket(data.buckets);
    // Period-end = now, so ages are exact: (10 + 4) / 2 = 7 over A and B; C is
    // resolved (its first done transition precedes now) so it is NOT counted.
    expect(latest).toMatchObject({ avgDays: 7, count: 2 });
    expect(data.windowAverage).not.toBeNull();
  });

  it('excludes an item created AFTER the period end (createdAt > periodEnd) and archived items', async () => {
    const fx = await makeWorkItemFixture();
    const open = await createTestWorkItem(fx, { kind: 'task', title: 'open' });
    const archived = await createTestWorkItem(fx, { kind: 'task', title: 'archived' });
    await setCreatedAt(open.id, daysAgo(6));
    await setCreatedAt(archived.id, daysAgo(6));
    await db.workItem.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });

    const data = await expectOk(
      reportsService.getAverageAge(
        { projectId: fx.projectId },
        { period: 'day', daysBack: 5 },
        fx.ctx,
      ),
    );
    // Only the one open, non-archived item counts in the latest bucket.
    expect(latestBucket(data.buckets)).toMatchObject({ avgDays: 6, count: 1 });
  });

  it('is all-null with a null windowAverage when every item is resolved', async () => {
    const fx = await makeWorkItemFixture();
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A' });
    await setCreatedAt(a.id, daysAgo(6));
    // Resolved BEFORE the earliest bucket end, so it is closed across the whole
    // window — and there are no other items.
    await addRevision(a.id, fx.ownerId, daysAgo(6), toDone);

    const data = await expectOk(
      reportsService.getAverageAge(
        { projectId: fx.projectId },
        { period: 'day', daysBack: 5 },
        fx.ctx,
      ),
    );
    expect(data.buckets.every((b) => b.avgDays === null && b.count === 0)).toBe(true);
    expect(data.windowAverage).toBeNull();
  });

  it('throws the typed 422 on an over-long daily window', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      reportsService.getAverageAge(
        { projectId: fx.projectId },
        { period: 'day', daysBack: 200 },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidReportWindowError);
  });
});
