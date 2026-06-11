import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { reportsService } from '@/lib/services/reportsService';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { InvalidReportWindowError } from '@/lib/reports/errors';
import { bucketAxis, bucketKey, reportWindow, type ReportPeriod } from '@/lib/reports/buckets';
import { encodeFilterParam, type FilterAst } from '@/lib/filters/ast';
import { makeWorkItemFixture, createTestWorkItem } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';
import type { Prisma } from '@prisma/client';

// Story 6.3 · Subtask 6.3.2 — reportsService.getCreatedVsResolved. Real
// Postgres, the burndown-test conventions: the resolved series is
// reconstructed from a SEEDED 1.4.6 revision trail at known offsets from
// "now" (the read is now-anchored, so fixtures are seeded relative to it),
// and the bucket matrix asserts: day/week/month grouping (the JS axis and
// the SQL date_trunc keys agree), the NET reopen rule, cumulative
// running-sums, window-edge inclusivity, the saved-filter scope, the
// bounded grouped shape of the repo read, and the typed window 422s. The
// permission/no-access matrix lives in widget-gating.test.ts; the at-scale
// matrices are Story 6.3.7's.

const DAY_MS = 24 * 60 * 60 * 1000;

/** An instant `days` whole days before now (same time of day — stays inside
 * the now-anchored window for any daysBack > days). */
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
  const key = bucketKey(period, d);
  return (buckets as Array<{ date: string; created: number; resolved: number }>).find(
    (b) => b.date === key,
  )!;
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

async function expectOk(promise: ReturnType<typeof reportsService.getCreatedVsResolved>) {
  const result = await promise;
  expect(result.state).toBe('ok');
  if (result.state !== 'ok') throw new Error('unreachable');
  return result.data;
}

describe('getCreatedVsResolved — the bucket matrix', () => {
  it('buckets created by createdAt and resolved as NET done-category transitions (a reopen subtracts), full axis with zero-filled buckets', async () => {
    const fx = await makeWorkItemFixture();
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A' });
    const b = await createTestWorkItem(fx, { kind: 'task', title: 'B' });
    const c = await createTestWorkItem(fx, { kind: 'task', title: 'C' });
    await setCreatedAt(a.id, daysAgo(6));
    await setCreatedAt(b.id, daysAgo(6));
    await setCreatedAt(c.id, daysAgo(2));

    // A resolved 4 days ago; B resolved 3 days ago then REOPENED 2 days ago
    // (the net rule: that bucket nets to -1 against C's day count of 0
    // resolves); B resolved again today.
    await addRevision(a.id, fx.ownerId, daysAgo(4), toDone);
    await addRevision(b.id, fx.ownerId, daysAgo(3), toDone);
    await addRevision(b.id, fx.ownerId, daysAgo(2), reopen);
    await addRevision(b.id, fx.ownerId, daysAgo(0), toDone);

    const data = await expectOk(
      reportsService.getCreatedVsResolved(
        { projectId: fx.projectId },
        { period: 'day', daysBack: 8, cumulative: false },
        fx.ctx,
      ),
    );

    expect(data.buckets).toHaveLength(8); // the FULL axis, event-less days present
    const at = (d: Date) => bucketOf(data.buckets, 'day', d);
    expect(at(daysAgo(6))).toMatchObject({ created: 2, resolved: 0 });
    expect(at(daysAgo(4))).toMatchObject({ created: 0, resolved: 1 });
    expect(at(daysAgo(3))).toMatchObject({ created: 0, resolved: 1 });
    expect(at(daysAgo(2))).toMatchObject({ created: 1, resolved: -1 }); // the reopen nets
    expect(at(daysAgo(0))).toMatchObject({ created: 0, resolved: 1 });
    expect(at(daysAgo(5))).toMatchObject({ created: 0, resolved: 0 }); // zero-filled

    // Series totals reconcile with the seeded counts.
    expect(data.buckets.reduce((s, x) => s + x.created, 0)).toBe(3);
    expect(data.buckets.reduce((s, x) => s + x.resolved, 0)).toBe(2); // 3 resolves − 1 reopen
  });

  it('cumulative running-sums both series server-side', async () => {
    const fx = await makeWorkItemFixture();
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A' });
    const b = await createTestWorkItem(fx, { kind: 'task', title: 'B' });
    await setCreatedAt(a.id, daysAgo(2));
    await setCreatedAt(b.id, daysAgo(1));
    await addRevision(a.id, fx.ownerId, daysAgo(1), toDone);
    await addRevision(a.id, fx.ownerId, daysAgo(0), reopen);

    const data = await expectOk(
      reportsService.getCreatedVsResolved(
        { projectId: fx.projectId },
        { period: 'day', daysBack: 3, cumulative: true },
        fx.ctx,
      ),
    );
    expect(data.cumulative).toBe(true);
    expect(data.buckets.map((x) => x.created)).toEqual([1, 2, 2]);
    expect(data.buckets.map((x) => x.resolved)).toEqual([0, 1, 0]); // the reopen nets the running sum back down
  });

  it.each(['week', 'month'] as const)(
    '%s buckets group on the date_trunc key the JS axis predicts',
    async (period) => {
      const fx = await makeWorkItemFixture();
      const a = await createTestWorkItem(fx, { kind: 'task', title: 'A' });
      const b = await createTestWorkItem(fx, { kind: 'task', title: 'B' });
      await setCreatedAt(a.id, daysAgo(20));
      await setCreatedAt(b.id, daysAgo(1));
      await addRevision(a.id, fx.ownerId, daysAgo(20), toDone);

      const data = await expectOk(
        reportsService.getCreatedVsResolved(
          { projectId: fx.projectId },
          { period, daysBack: 30, cumulative: false },
          fx.ctx,
        ),
      );

      // The axis matches the pure generator (whose date_trunc parity is
      // unit-tested) and every seeded event lands in its predicted bucket.
      const { start, end } = reportWindow(new Date(), 30);
      expect(data.buckets.map((x) => x.date)).toEqual(bucketAxis(period, start, end));
      expect(bucketOf(data.buckets, period, daysAgo(20)).created).toBeGreaterThanOrEqual(1);
      expect(bucketOf(data.buckets, period, daysAgo(20)).resolved).toBe(1);
      expect(bucketOf(data.buckets, period, daysAgo(1)).created).toBeGreaterThanOrEqual(1);
      expect(data.buckets.reduce((s, x) => s + x.created, 0)).toBe(2);
    },
  );

  it('window edges are inclusive: events inside the first window day count, older ones do not', async () => {
    const fx = await makeWorkItemFixture();
    const inWindow = await createTestWorkItem(fx, { kind: 'task', title: 'in' });
    const before = await createTestWorkItem(fx, { kind: 'task', title: 'before' });
    // daysBack 5 → the window starts at UTC midnight 4 days ago: an event 4
    // days ago (same time of day) is inside; 5 days ago is out.
    await setCreatedAt(inWindow.id, daysAgo(4));
    await setCreatedAt(before.id, daysAgo(5));
    await addRevision(inWindow.id, fx.ownerId, daysAgo(4), toDone);
    await addRevision(before.id, fx.ownerId, daysAgo(5), toDone);

    const data = await expectOk(
      reportsService.getCreatedVsResolved(
        { projectId: fx.projectId },
        { period: 'day', daysBack: 5, cumulative: false },
        fx.ctx,
      ),
    );
    expect(data.buckets.reduce((s, x) => s + x.created, 0)).toBe(1);
    expect(data.buckets.reduce((s, x) => s + x.resolved, 0)).toBe(1);
  });

  it('archived items are excluded from both series (the /issues parity basis)', async () => {
    const fx = await makeWorkItemFixture();
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A' });
    await setCreatedAt(a.id, daysAgo(1));
    await addRevision(a.id, fx.ownerId, daysAgo(1), toDone);
    await db.workItem.update({ where: { id: a.id }, data: { archivedAt: new Date() } });

    const data = await expectOk(
      reportsService.getCreatedVsResolved(
        { projectId: fx.projectId },
        { period: 'day', daysBack: 3, cumulative: false },
        fx.ctx,
      ),
    );
    expect(data.buckets.every((x) => x.created === 0 && x.resolved === 0)).toBe(true);
  });
});

describe('getCreatedVsResolved — saved-filter scope', () => {
  it('a filter scope narrows BOTH series through the compiled AST', async () => {
    const fx = await makeWorkItemFixture();
    const hi = await createTestWorkItem(fx, { kind: 'task', title: 'hi' });
    const lo = await createTestWorkItem(fx, { kind: 'task', title: 'lo' });
    await db.workItem.update({ where: { id: hi.id }, data: { priority: 'high' } });
    await db.workItem.update({ where: { id: lo.id }, data: { priority: 'low' } });
    await setCreatedAt(hi.id, daysAgo(1));
    await setCreatedAt(lo.id, daysAgo(1));
    await addRevision(hi.id, fx.ownerId, daysAgo(0), toDone);
    await addRevision(lo.id, fx.ownerId, daysAgo(0), toDone);

    const ast: FilterAst = {
      combinator: 'and',
      conditions: [{ field: 'priority', operator: 'is_any_of', value: ['high'] }],
    };
    const filter = await savedFiltersService.create(
      fx.projectIdentifier,
      { name: 'High only', visibility: 'project', filterParam: encodeFilterParam(ast) },
      fx.ctx,
    );

    const data = await expectOk(
      reportsService.getCreatedVsResolved(
        { savedFilterId: filter.id },
        { period: 'day', daysBack: 3, cumulative: false },
        fx.ctx,
      ),
    );
    expect(data.buckets.reduce((s, x) => s + x.created, 0)).toBe(1);
    expect(data.buckets.reduce((s, x) => s + x.resolved, 0)).toBe(1);
  });
});

describe('getCreatedVsResolved — bounded shape + caps', () => {
  it('the resolved derivation is ONE grouped query: the repo returns ≤ one row per bucket, fast, on a few hundred seeded revisions', async () => {
    const fx = await makeWorkItemFixture();
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A' });
    // 300 alternating resolve/reopen revisions across 10 days.
    await db.workItemRevision.createMany({
      data: Array.from({ length: 300 }, (_, i) => ({
        workItemId: a.id,
        changedById: fx.ownerId,
        changeKind: 'updated' as const,
        changedAt: daysAgo(i % 10),
        diff: i % 2 === 0 ? toDone : reopen,
      })),
    });

    const window = reportWindow(new Date(), 14);
    const started = Date.now();
    const rows = await workItemRevisionRepository.aggregateNetResolvedByBucket(
      fx.projectId,
      fx.workspaceId,
      'day',
      window,
    );
    const elapsed = Date.now() - started;
    // GROUPed server-side: a row per event day (≤ 10), never per revision.
    expect(rows.length).toBeLessThanOrEqual(10);
    expect(rows.reduce((s, r) => s + r.resolved, 0)).toBe(0); // 150 resolves − 150 reopens
    expect(elapsed).toBeLessThan(5_000); // timing sanity (the at-scale bound is 6.3.7's)
  });

  it('window caps are the typed 422 (daysBack range; the daily bucket cap)', async () => {
    const fx = await makeWorkItemFixture();
    for (const config of [
      { period: 'day' as const, daysBack: 0 },
      { period: 'day' as const, daysBack: 121 },
      { period: 'week' as const, daysBack: 367 },
      { period: 'month' as const, daysBack: 2.5 },
    ]) {
      await expect(
        reportsService.getCreatedVsResolved(
          { projectId: fx.projectId },
          { ...config, cumulative: false },
          fx.ctx,
        ),
      ).rejects.toThrow(InvalidReportWindowError);
    }
  });
});
