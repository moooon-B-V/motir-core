import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { makeWorkItemFixture, createTestWorkItem } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// Repository-layer tests for the Story 6.12 · Subtask 6.12.4 Overview stat
// methods on workItemRepository (the per-file coverage-gated file). Real
// Postgres, no DB mocks; the truncate helper CASCADE-resets between tests.
// Default-workflow status keys → categories: todo/blocked → `todo`,
// in_progress/in_review → `in_progress`, done/cancelled → `done`.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Force a work item's status key directly (a read-stat test doesn't transition). */
async function setStatus(id: string, status: string): Promise<void> {
  await db.workItem.update({ where: { id }, data: { status } });
}

describe('workItemRepository.countByStatusCategory', () => {
  it('buckets non-archived, non-triage items by workflow-status category', async () => {
    const fx = await makeWorkItemFixture();

    // todo bucket: one `todo` + one `blocked`.
    const todoA = await createTestWorkItem(fx, { kind: 'task', title: 'todo a' });
    await setStatus(todoA.id, 'todo');
    const blocked = await createTestWorkItem(fx, { kind: 'task', title: 'blocked b' });
    await setStatus(blocked.id, 'blocked');

    // in_progress bucket: one `in_progress` + one `in_review`.
    const ip = await createTestWorkItem(fx, { kind: 'task', title: 'wip c' });
    await setStatus(ip.id, 'in_progress');
    const ir = await createTestWorkItem(fx, { kind: 'task', title: 'review d' });
    await setStatus(ir.id, 'in_review');

    // done bucket: one `done` + one `cancelled`.
    const done = await createTestWorkItem(fx, { kind: 'task', title: 'done e' });
    await setStatus(done.id, 'done');
    const cancelled = await createTestWorkItem(fx, { kind: 'task', title: 'cancelled f' });
    await setStatus(cancelled.id, 'cancelled');

    const counts = await workItemRepository.countByStatusCategory(fx.projectId, fx.workspaceId);
    expect(counts).toEqual({ todo: 2, in_progress: 2, done: 2 });
  });

  it('excludes archived and triage items from the buckets', async () => {
    const fx = await makeWorkItemFixture();
    const live = await createTestWorkItem(fx, { kind: 'task', title: 'live' });
    await setStatus(live.id, 'in_progress');

    const archived = await createTestWorkItem(fx, { kind: 'task', title: 'archived' });
    await db.workItem.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });

    const triaged = await createTestWorkItem(fx, { kind: 'bug', title: 'triaged' });
    await db.workItem.update({ where: { id: triaged.id }, data: { triagedAt: new Date() } });

    const counts = await workItemRepository.countByStatusCategory(fx.projectId, fx.workspaceId);
    expect(counts).toEqual({ todo: 0, in_progress: 1, done: 0 });
  });

  it('returns an all-zero map for a project with no work items', async () => {
    const fx = await makeWorkItemFixture();
    const counts = await workItemRepository.countByStatusCategory(fx.projectId, fx.workspaceId);
    expect(counts).toEqual({ todo: 0, in_progress: 0, done: 0 });
  });
});

describe('workItemRepository.countTriageItems', () => {
  it('counts only non-archived triage-queued items', async () => {
    const fx = await makeWorkItemFixture();

    // Two triage items (the public-request inbox 6.12.5 feeds).
    for (const title of ['req 1', 'req 2']) {
      const wi = await createTestWorkItem(fx, { kind: 'bug', title });
      await db.workItem.update({ where: { id: wi.id }, data: { triagedAt: new Date() } });
    }
    // A normal (non-triage) item — must NOT count.
    await createTestWorkItem(fx, { kind: 'task', title: 'normal' });
    // An archived triage item — must NOT count.
    const archived = await createTestWorkItem(fx, { kind: 'bug', title: 'old req' });
    await db.workItem.update({
      where: { id: archived.id },
      data: { triagedAt: new Date(), archivedAt: new Date() },
    });

    expect(await workItemRepository.countTriageItems(fx.projectId, fx.workspaceId)).toBe(2);
  });

  it('returns 0 when the project has no triage items', async () => {
    const fx = await makeWorkItemFixture();
    await createTestWorkItem(fx, { kind: 'task', title: 'normal' });
    expect(await workItemRepository.countTriageItems(fx.projectId, fx.workspaceId)).toBe(0);
  });
});
