import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { DEFAULT_SORT, type IssueSort } from '@/lib/issues/issueListView';
import { truncateAuthTables } from '../../helpers/db';
import {
  makeWorkItemFixture as makeFixture,
  createTestWorkItem as createWorkItem,
  type WorkItemFixture,
} from '../../fixtures';

// Integration tests for the LAZY tree read contract (Subtask 2.5.13, finding
// #57): workItemsService.listRootIssues / listChildIssues over
// workItemRepository.findProjectTreeLevel — one sorted, paged level at a time,
// each row carrying `hasChildren`, workspace-gated. Real Postgres, no mocks.

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_revision", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

/**
 * The canonical forest (keys in creation order):
 *   E (epic, root, key 1) ├─ A (story 2) └─ B (story 5)
 *                          A └─ A1 (task 3) └─ A1a (subtask 4)
 *                          B └─ B1 (task 6)
 *   X (bug, root, key 7)
 */
async function buildForest(fx: WorkItemFixture) {
  const E = await createWorkItem(fx, { kind: 'epic', title: 'Epic E' });
  const A = await createWorkItem(fx, { kind: 'story', title: 'Story A', parentId: E.id });
  const A1 = await createWorkItem(fx, { kind: 'task', title: 'Task A1', parentId: A.id });
  const A1a = await createWorkItem(fx, { kind: 'subtask', title: 'Subtask A1a', parentId: A1.id });
  const B = await createWorkItem(fx, { kind: 'story', title: 'Story B', parentId: E.id });
  const B1 = await createWorkItem(fx, { kind: 'task', title: 'Task B1', parentId: B.id });
  const X = await createWorkItem(fx, { kind: 'bug', title: 'Bug X' });
  return { E, A, A1, A1a, B, B1, X };
}

const sort = (s: Partial<IssueSort> = {}): IssueSort => ({ ...DEFAULT_SORT, ...s });

describe('listRootIssues', () => {
  it('returns the project roots (key asc) with hasChildren + no nesting', async () => {
    const fx = await makeFixture();
    const { E, X } = await buildForest(fx);

    const level = await workItemsService.listRootIssues(fx.projectId, { sort: sort() }, fx.ctx);

    expect(level.rows.map((r) => r.id)).toEqual([E.id, X.id]); // roots only, key asc
    expect(level.rows.find((r) => r.id === E.id)?.hasChildren).toBe(true);
    expect(level.rows.find((r) => r.id === X.id)?.hasChildren).toBe(false);
    expect(level.rows.every((r) => r.parentId === null)).toBe(true);
    expect(level.hasMore).toBe(false);
    expect(level.total).toBe(2); // the FULL roots count (for aria-setsize)
  });

  it('pages with take/offset and reports hasMore', async () => {
    const fx = await makeFixture();
    const { E, X } = await buildForest(fx);

    const p1 = await workItemsService.listRootIssues(
      fx.projectId,
      { sort: sort(), take: 1, offset: 0 },
      fx.ctx,
    );
    expect(p1.rows.map((r) => r.id)).toEqual([E.id]);
    expect(p1.hasMore).toBe(true);
    expect(p1.total).toBe(2); // total is the FULL count, not the page size

    const p2 = await workItemsService.listRootIssues(
      fx.projectId,
      { sort: sort(), take: 1, offset: 1 },
      fx.ctx,
    );
    expect(p2.rows.map((r) => r.id)).toEqual([X.id]);
    expect(p2.hasMore).toBe(false);
  });

  it("throws ProjectNotFoundError for another workspace's project (no leak)", async () => {
    const fxA = await makeFixture({ name: 'Acme A', identifier: 'AAA' });
    const fxB = await makeFixture({ name: 'Acme B', identifier: 'BBB' });
    await buildForest(fxB);
    await expect(
      workItemsService.listRootIssues(fxB.projectId, { sort: sort() }, fxA.ctx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('listChildIssues', () => {
  it("returns a parent's direct children (key asc) with hasChildren", async () => {
    const fx = await makeFixture();
    const { E, A, B } = await buildForest(fx);

    const level = await workItemsService.listChildIssues(E.id, { sort: sort() }, fx.ctx);

    expect(level.rows.map((r) => r.id)).toEqual([A.id, B.id]); // E's direct children only
    expect(level.rows.every((r) => r.parentId === E.id)).toBe(true);
    expect(level.rows.every((r) => r.hasChildren)).toBe(true); // A→A1, B→B1
    expect(level.hasMore).toBe(false);
    expect(level.total).toBe(2); // E has exactly 2 children
  });

  it('returns an empty level for a leaf (no children)', async () => {
    const fx = await makeFixture();
    const { A1a } = await buildForest(fx);
    const level = await workItemsService.listChildIssues(A1a.id, { sort: sort() }, fx.ctx);
    expect(level.rows).toEqual([]);
    expect(level.hasMore).toBe(false);
  });

  it('sorts siblings within the parent by the active sort', async () => {
    const fx = await makeFixture();
    const { E, A, B } = await buildForest(fx);
    const level = await workItemsService.listChildIssues(
      E.id,
      { sort: sort({ column: 'title', direction: 'desc' }) },
      fx.ctx,
    );
    expect(level.rows.map((r) => r.id)).toEqual([B.id, A.id]); // "Story B" > "Story A" desc
  });

  it('throws WorkItemNotFoundError for an unknown parent', async () => {
    const fx = await makeFixture();
    await expect(
      workItemsService.listChildIssues('does-not-exist', { sort: sort() }, fx.ctx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });

  it('throws WorkItemNotFoundError for a parent in another workspace (no leak)', async () => {
    const fxA = await makeFixture({ name: 'Acme A', identifier: 'AAA' });
    const fxB = await makeFixture({ name: 'Acme B', identifier: 'BBB' });
    const { E } = await buildForest(fxB);
    await expect(
      workItemsService.listChildIssues(E.id, { sort: sort() }, fxA.ctx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });
});
