import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { reportsService } from '@/lib/services/reportsService';
import { bucketKey, type ReportPeriod } from '@/lib/reports/buckets';
import { expectedCreatedVsResolved } from '@/tests/e2e/_helpers/reporting';
import { makeWorkItemFixture, createTestWorkItem } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import type { Prisma } from '@/generated/prisma/client';

// MOTIR-3843 — the ORACLE and the REPORT must compute the SAME QUANTITY.
//
// `expectedCreatedVsResolved` (tests/e2e/_helpers/reporting.ts) is the
// independent recompute the epic6-at-scale spec asserts the report against. It
// used to date a resolution by `_max(changedAt)` over ALL of a currently-done
// item's revisions — "when the item was last touched" — while the report dates
// it by the transition INTO a done-category status. The two agree only while no
// resolved item is ever revised again, which is a property of the at-scale
// fixture's write ORDER rather than of the quantity; the day a trailing revision
// landed in a later bucket, `reporting-at-scale` went red on `main` and, because
// `deploy` needs `e2e-at-scale`, every production release stopped.
//
// These cases pin the divergence WITHOUT the at-scale corpus: a handful of items
// and a hand-written revision trail are enough, which is exactly why this is the
// regression that would have caught it. The at-scale spec remains the assembled
// check; it is not the place a definition mismatch should first be noticed.

const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD: ReportPeriod = 'week';
const DAYS_BACK = 182;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

async function addRevision(
  workItemId: string,
  changedById: string,
  changedAt: Date,
  diff: Prisma.InputJsonValue,
): Promise<void> {
  await adminDb.workItemRevision.create({
    data: { workItemId, changedById, changeKind: 'updated', changedAt, diff },
  });
}

async function setStatus(id: string, status: string): Promise<void> {
  await adminDb.workItem.update({ where: { id }, data: { status } });
}

async function setCreatedAt(id: string, createdAt: Date): Promise<void> {
  await adminDb.workItem.update({ where: { id }, data: { createdAt } });
}

const toDone = { status: { from: 'in_review', to: 'done' } };
const reopen = { status: { from: 'done', to: 'todo' } };
const priorityEdit = { priority: { from: 'low', to: 'highest' } };

/** The report's resolved series, as a bucketKey → count map. */
async function reportResolved(
  projectId: string,
  ctx: { userId: string; workspaceId: string },
): Promise<Record<string, number>> {
  const result = await reportsService.getCreatedVsResolved(
    { projectId },
    { period: PERIOD, daysBack: DAYS_BACK, cumulative: false },
    ctx,
  );
  expect(result.state).toBe('ok');
  if (result.state !== 'ok') throw new Error('unreachable');
  return Object.fromEntries(result.data.buckets.map((b) => [b.date, b.resolved]));
}

/** The oracle's resolved series, as the at-scale spec obtains it. */
async function oracleResolved(
  projectId: string,
  workspaceId: string,
): Promise<Record<string, number>> {
  const expected = await expectedCreatedVsResolved(projectId, workspaceId, {
    now: new Date(),
    period: PERIOD,
    daysBack: DAYS_BACK,
  });
  return expected.resolved;
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the created-vs-resolved ORACLE computes the report’s quantity (MOTIR-3843)', () => {
  it('dates a resolution by the transition into done, NOT by a later unrelated edit', async () => {
    const fx = await makeWorkItemFixture();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'resolved, then edited' });
    await setCreatedAt(item.id, daysAgo(120));

    // Resolved 100 days ago; then touched 2 days ago by an ordinary field edit
    // that says nothing about resolution. `max(changedAt)` is the EDIT.
    const resolvedAt = daysAgo(100);
    await addRevision(item.id, fx.ownerId, resolvedAt, toDone);
    await addRevision(item.id, fx.ownerId, daysAgo(2), priorityEdit);
    await setStatus(item.id, 'done');

    const report = await reportResolved(fx.projectId, fx.ctx);
    const oracle = await oracleResolved(fx.projectId, fx.workspaceId);

    const resolutionBucket = bucketKey(PERIOD, resolvedAt);
    const editBucket = bucketKey(PERIOD, daysAgo(2));
    expect(resolutionBucket).not.toBe(editBucket); // the case is only a case if they differ

    // BOTH sides count it in the RESOLUTION's bucket, and neither in the edit's.
    expect(report[resolutionBucket]).toBe(1);
    expect(oracle[resolutionBucket]).toBe(1);
    expect(report[editBucket]).toBe(0);
    expect(oracle[editBucket]).toBe(0);
    expect(oracle).toEqual(report);
  });

  it('nets a reopen: the resolution bucket keeps its +1 and the reopen bucket goes -1', async () => {
    const fx = await makeWorkItemFixture();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'resolved, then reopened' });
    await setCreatedAt(item.id, daysAgo(60));

    const resolvedAt = daysAgo(50);
    const reopenedAt = daysAgo(9);
    await addRevision(item.id, fx.ownerId, resolvedAt, toDone);
    await addRevision(item.id, fx.ownerId, reopenedAt, reopen);
    await setStatus(item.id, 'todo'); // currently OPEN — the old oracle saw nothing at all

    const report = await reportResolved(fx.projectId, fx.ctx);
    const oracle = await oracleResolved(fx.projectId, fx.workspaceId);

    expect(bucketKey(PERIOD, resolvedAt)).not.toBe(bucketKey(PERIOD, reopenedAt));
    expect(oracle[bucketKey(PERIOD, resolvedAt)]).toBe(1);
    expect(oracle[bucketKey(PERIOD, reopenedAt)]).toBe(-1);
    expect(oracle).toEqual(report);
  });

  it('counts the EVENTS, so a resolve → reopen → resolve trail agrees bucket for bucket', async () => {
    const fx = await makeWorkItemFixture();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'resolved twice' });
    await setCreatedAt(item.id, daysAgo(80));

    await addRevision(item.id, fx.ownerId, daysAgo(70), toDone);
    await addRevision(item.id, fx.ownerId, daysAgo(40), reopen);
    await addRevision(item.id, fx.ownerId, daysAgo(30), toDone);
    await addRevision(item.id, fx.ownerId, daysAgo(3), priorityEdit);
    await setStatus(item.id, 'done');

    const report = await reportResolved(fx.projectId, fx.ctx);
    const oracle = await oracleResolved(fx.projectId, fx.workspaceId);

    expect(oracle[bucketKey(PERIOD, daysAgo(70))]).toBe(1);
    expect(oracle[bucketKey(PERIOD, daysAgo(40))]).toBe(-1);
    expect(oracle[bucketKey(PERIOD, daysAgo(30))]).toBe(1);
    expect(oracle[bucketKey(PERIOD, daysAgo(3))]).toBe(0);
    expect(oracle).toEqual(report);
  });

  it('excludes an ARCHIVED item’s resolution, on the same side the report excludes it', async () => {
    const fx = await makeWorkItemFixture();
    const kept = await createTestWorkItem(fx, { kind: 'task', title: 'kept' });
    const archived = await createTestWorkItem(fx, { kind: 'task', title: 'archived' });
    await setCreatedAt(kept.id, daysAgo(40));
    await setCreatedAt(archived.id, daysAgo(40));

    const resolvedAt = daysAgo(20);
    await addRevision(kept.id, fx.ownerId, resolvedAt, toDone);
    await addRevision(archived.id, fx.ownerId, resolvedAt, toDone);
    await setStatus(kept.id, 'done');
    await setStatus(archived.id, 'done');
    await adminDb.workItem.update({
      where: { id: archived.id },
      data: { archivedAt: new Date() },
    });

    const report = await reportResolved(fx.projectId, fx.ctx);
    const oracle = await oracleResolved(fx.projectId, fx.workspaceId);

    expect(oracle[bucketKey(PERIOD, resolvedAt)]).toBe(1);
    expect(oracle).toEqual(report);
  });
});
