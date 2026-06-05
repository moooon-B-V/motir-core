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

    const rows = await workItemsService.getProjectIssuesList(
      fx.projectId,
      { sort: DEFAULT_SORT },
      fx.ctx,
    );

    // All three, flat, in key order — the nesting is gone.
    expect(ids(rows)).toEqual(['PROD-1', 'PROD-2', 'PROD-3']);
  });

  it('sorts by key descending', async () => {
    const fx = await makeFixture();
    await createWorkItem(fx, { kind: 'task', title: 'A' });
    await createWorkItem(fx, { kind: 'task', title: 'B' });
    await createWorkItem(fx, { kind: 'task', title: 'C' });

    const sort: IssueSort = { column: 'key', direction: 'desc' };
    const rows = await workItemsService.getProjectIssuesList(fx.projectId, { sort }, fx.ctx);
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

    const desc = await workItemsService.getProjectIssuesList(
      fx.projectId,
      { sort: { column: 'priority', direction: 'desc' } },
      fx.ctx,
    );
    expect(ids(desc)).toEqual([highest.identifier, medium.identifier, low.identifier]);

    const asc = await workItemsService.getProjectIssuesList(
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

    const asc = await workItemsService.getProjectIssuesList(
      fx.projectId,
      { sort: { column: 'due', direction: 'asc' } },
      fx.ctx,
    );
    // early < late, then the undated row last (NULLS LAST).
    expect(ids(asc)).toEqual([early.identifier, late.identifier, noDue.identifier]);

    const desc = await workItemsService.getProjectIssuesList(
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
    const rowsA = await workItemsService.getProjectIssuesList(
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
    const rows = await workItemsService.getProjectIssuesList(
      fx.projectId,
      { sort: DEFAULT_SORT },
      fx.ctx,
    );
    expect(rows).toEqual([]);
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
    const rows = toIssueListRows(items, workflow, members);

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
