import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { toIssueListRows } from '@/app/(authed)/issues/_components/issueRows';
import { DEFAULT_SORT, type IssueSort } from '@/lib/issues/issueListView';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { truncateAuthTables } from '../../helpers/db';
import {
  makeWorkItemFixture as makeFixture,
  createTestWorkItem as createWorkItem,
} from '../../fixtures';

// The flat sortable List read (Subtask 2.5.8) against a REAL Postgres (Yue's
// no-mocks rule). `workItemsService.getProjectIssuesList` is the `view=list`
// data path: the project's issues UN-NESTED + ordered by the active column at
// the DB layer (a flat ORDER BY — no JS re-sorting). These drive the ordering
// per column, the cross-workspace gate, and the shared row shaping.

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_revision", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
});

const ids = (rows: { identifier: string }[]) => rows.map((r) => r.identifier);

describe('getProjectIssuesList (flat sorted List read)', () => {
  it('defaults to key ascending and un-nests the tree (parents + children flat)', async () => {
    const fx = await makeFixture();
    const epic = await createWorkItem(fx, { kind: 'epic', title: 'Epic' });
    const story = await createWorkItem(fx, { kind: 'story', title: 'Story', parentId: epic.id });
    await createWorkItem(fx, { kind: 'task', title: 'Task', parentId: story.id });

    const { items: rows } = await workItemsService.getProjectIssuesList(
      fx.projectId,
      { sort: DEFAULT_SORT },
      fx.ctx,
    );

    // All three, flat, in key order — the nesting is gone.
    expect(ids(rows)).toEqual(['PROD-1', 'PROD-2', 'PROD-3']);
  });

  it("projects each item's work `type` (Subtask 8.8.9 — Type column)", async () => {
    const fx = await makeFixture();
    const epic = await createWorkItem(fx, { kind: 'epic', title: 'Epic' });
    const task = await createWorkItem(fx, { kind: 'task', title: 'Task' });
    await db.workItem.update({ where: { id: task.id }, data: { type: 'code' } });

    const { items: rows } = await workItemsService.getProjectIssuesList(
      fx.projectId,
      { sort: DEFAULT_SORT },
      fx.ctx,
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(task.id)?.type).toBe('code');
    expect(byId.get(epic.id)?.type).toBeNull(); // container — no work type
  });

  it('sorts by key descending', async () => {
    const fx = await makeFixture();
    await createWorkItem(fx, { kind: 'task', title: 'A' });
    await createWorkItem(fx, { kind: 'task', title: 'B' });
    await createWorkItem(fx, { kind: 'task', title: 'C' });

    const sort: IssueSort = { column: 'key', direction: 'desc' };
    const { items: rows } = await workItemsService.getProjectIssuesList(
      fx.projectId,
      { sort },
      fx.ctx,
    );
    expect(ids(rows)).toEqual(['PROD-3', 'PROD-2', 'PROD-1']);
  });

  it('sorts by priority (enum order lowest→highest); desc lists highest first', async () => {
    const fx = await makeFixture();
    const low = await createWorkItem(fx, { kind: 'task', title: 'low' });
    const highest = await createWorkItem(fx, { kind: 'bug', title: 'highest' });
    const medium = await createWorkItem(fx, { kind: 'task', title: 'medium' });
    await db.workItem.update({ where: { id: low.id }, data: { priority: 'low' } });
    await db.workItem.update({ where: { id: highest.id }, data: { priority: 'highest' } });
    await db.workItem.update({ where: { id: medium.id }, data: { priority: 'medium' } });

    const { items: desc } = await workItemsService.getProjectIssuesList(
      fx.projectId,
      { sort: { column: 'priority', direction: 'desc' } },
      fx.ctx,
    );
    expect(ids(desc)).toEqual([highest.identifier, medium.identifier, low.identifier]);

    const { items: asc } = await workItemsService.getProjectIssuesList(
      fx.projectId,
      { sort: { column: 'priority', direction: 'asc' } },
      fx.ctx,
    );
    expect(ids(asc)).toEqual([low.identifier, medium.identifier, highest.identifier]);
  });

  it('sorts by due date with NULLs last in both directions', async () => {
    const fx = await makeFixture();
    const noDue = await createWorkItem(fx, { kind: 'task', title: 'no due' });
    const early = await createWorkItem(fx, { kind: 'task', title: 'early' });
    const late = await createWorkItem(fx, { kind: 'task', title: 'late' });
    await db.workItem.update({
      where: { id: early.id },
      data: { dueDate: new Date('2026-06-07') },
    });
    await db.workItem.update({ where: { id: late.id }, data: { dueDate: new Date('2026-06-20') } });

    const { items: asc } = await workItemsService.getProjectIssuesList(
      fx.projectId,
      { sort: { column: 'due', direction: 'asc' } },
      fx.ctx,
    );
    // early < late, then the undated row last (NULLS LAST).
    expect(ids(asc)).toEqual([early.identifier, late.identifier, noDue.identifier]);

    const { items: desc } = await workItemsService.getProjectIssuesList(
      fx.projectId,
      { sort: { column: 'due', direction: 'desc' } },
      fx.ctx,
    );
    // late > early, undated row STILL last (NULLS LAST regardless of direction).
    expect(ids(desc)).toEqual([late.identifier, early.identifier, noDue.identifier]);
  });

  it('is workspace-scoped: a cross-workspace project id is not-found, never a leak', async () => {
    const a = await makeFixture({ name: 'Acme', identifier: 'AAA' });
    const b = await makeFixture({ name: 'Beta', identifier: 'BBB' });
    await createWorkItem(a, { kind: 'task', title: 'A-only' });
    await createWorkItem(b, { kind: 'task', title: 'B-only' });

    // Workspace A's project, read with workspace A's ctx → only A's item.
    const { items: rowsA } = await workItemsService.getProjectIssuesList(
      a.projectId,
      { sort: DEFAULT_SORT },
      a.ctx,
    );
    expect(ids(rowsA)).toEqual(['AAA-1']);

    // Workspace A's project id, read with workspace B's ctx → ProjectNotFound
    // (the gate treats a foreign id as missing, not an empty list).
    await expect(
      workItemsService.getProjectIssuesList(a.projectId, { sort: DEFAULT_SORT }, b.ctx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('an empty project returns []', async () => {
    const fx = await makeFixture();
    const { items: rows } = await workItemsService.getProjectIssuesList(
      fx.projectId,
      { sort: DEFAULT_SORT },
      fx.ctx,
    );
    expect(rows).toEqual([]);
  });
});

describe('getProjectIssuesList — server-side pagination (Subtask 2.5.12)', () => {
  it('pages by 50, holds the remainder on the last page, and clamps an over-range page', async () => {
    const fx = await makeFixture();
    // 52 roots → 2 pages (50 + 2). Keys allocate 1..52 in creation order.
    for (let i = 0; i < 52; i++) await createWorkItem(fx, { kind: 'task', title: `T${i}` });

    const p1 = await workItemsService.getProjectIssuesList(
      fx.projectId,
      { sort: DEFAULT_SORT, page: 1 },
      fx.ctx,
    );
    expect({ total: p1.total, page: p1.page, pageSize: p1.pageSize }).toEqual({
      total: 52,
      page: 1,
      pageSize: 50,
    });
    expect(p1.items).toHaveLength(50);
    expect(p1.items[0]!.identifier).toBe('PROD-1');

    const p2 = await workItemsService.getProjectIssuesList(
      fx.projectId,
      { sort: DEFAULT_SORT, page: 2 },
      fx.ctx,
    );
    expect(p2.page).toBe(2);
    expect(p2.items.map((r) => r.identifier)).toEqual(['PROD-51', 'PROD-52']);
    // No row appears on both pages (OFFSET paging over a total order).
    const onP1 = new Set(p1.items.map((r) => r.id));
    expect(p2.items.some((r) => onP1.has(r.id))).toBe(false);

    // An out-of-range page clamps to the last page (the 2.5.10 edge spec).
    const over = await workItemsService.getProjectIssuesList(
      fx.projectId,
      { sort: DEFAULT_SORT, page: 99 },
      fx.ctx,
    );
    expect(over.page).toBe(2);
    expect(over.items.map((r) => r.identifier)).toEqual(['PROD-51', 'PROD-52']);
  });

  it('the total tracks the active filter — the filtered count, not the whole project', async () => {
    const fx = await makeFixture();
    for (let i = 0; i < 8; i++) await createWorkItem(fx, { kind: 'task', title: `task ${i}` });
    for (let i = 0; i < 3; i++) await createWorkItem(fx, { kind: 'bug', title: `bug ${i}` });

    const bugs = await workItemsService.getProjectIssuesList(
      fx.projectId,
      { sort: DEFAULT_SORT, filter: { kinds: ['bug'] }, page: 1 },
      fx.ctx,
    );
    expect(bugs.total).toBe(3);
    expect(bugs.items).toHaveLength(3);
    expect(bugs.items.every((r) => r.kind === 'bug')).toBe(true);
  });

  it('an empty project paginates to total 0, page 1, no items', async () => {
    const fx = await makeFixture();
    const res = await workItemsService.getProjectIssuesList(
      fx.projectId,
      { sort: DEFAULT_SORT },
      fx.ctx,
    );
    expect(res).toEqual({ items: [], total: 0, page: 1, pageSize: 50 });
  });
});

describe('toIssueListRows (flat shaping over the live reads)', () => {
  it('resolves status label/category + assignee name, preserving the read order', async () => {
    const fx = await makeFixture();
    const assigned = await createWorkItem(fx, { kind: 'task', title: 'Assigned' });
    const unassigned = await createWorkItem(fx, { kind: 'task', title: 'Unassigned' });
    await db.workItem.update({
      where: { id: assigned.id },
      data: { status: 'in_progress', assigneeId: fx.ownerId },
    });
    await db.workItem.update({ where: { id: unassigned.id }, data: { status: 'todo' } });

    const [items, workflow, members] = await Promise.all([
      workItemsService.getProjectIssuesList(fx.projectId, { sort: DEFAULT_SORT }, fx.ctx),
      workflowsService.getWorkflow(fx.projectId, fx.workspaceId),
      workspacesService.listMembers(fx.workspaceId, fx.ownerId),
    ]);
    const rows = toIssueListRows(items.items, workflow, members);

    expect(ids(rows)).toEqual(['PROD-1', 'PROD-2']); // key-asc order preserved
    expect(rows[0]).toMatchObject({
      identifier: 'PROD-1',
      statusCategory: 'in_progress',
      assigneeName: fx.owner.name,
    });
    expect(rows[1]).toMatchObject({
      identifier: 'PROD-2',
      statusCategory: 'todo',
      assigneeName: null,
    });
  });
});
