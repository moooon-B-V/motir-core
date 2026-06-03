import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { truncateAuthTables } from '../../helpers/db';
import { makeWorkItemFixture } from '../../fixtures';

// getIssueDetail — the aggregate read backing the issue DETAIL page (Subtask
// 2.4.1), against a REAL Postgres (no-mocks rule). Proves the one-call bundle
// (item + parent + children + blocked-by/blocks + workflow) and the tenant gate.

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(truncateAll);
afterAll(async () => {
  await db.$disconnect();
});

describe('workItemsService.getIssueDetail (2.4.1)', () => {
  it('bundles the item + parent + children + blocked-by / blocks + workflow', async () => {
    const fx = await makeWorkItemFixture();
    // Canonical legal chain: epic → story → task → subtask (2.1 matrix).
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Top epic' },
      fx.ctx,
    );
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Parent story', parentId: epic.id },
      fx.ctx,
    );
    const task = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'The task', parentId: story.id },
      fx.ctx,
    );
    const subtask = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'subtask', title: 'A subtask', parentId: task.id },
      fx.ctx,
    );
    // A sibling task that blocks `task`.
    const blocker = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Blocker', parentId: story.id },
      fx.ctx,
    );
    await workItemsService.linkWorkItems(
      { fromId: task.id, toId: blocker.id, kind: 'is_blocked_by' },
      fx.ctx,
    );

    const detail = await workItemsService.getIssueDetail(fx.projectId, task.identifier, fx.ctx);
    expect(detail.item.identifier).toBe(task.identifier);
    expect(detail.item.title).toBe('The task');
    expect(detail.parent?.identifier).toBe(story.identifier);
    expect(detail.children.map((c) => c.identifier)).toEqual([subtask.identifier]);
    expect(detail.blockedBy.map((b) => b.identifier)).toEqual([blocker.identifier]);
    expect(detail.blocks).toEqual([]);
    expect(detail.workflow.statuses.length).toBeGreaterThan(0);

    // The blocker's own detail sees the reverse edge: it `blocks` the task.
    const blockerDetail = await workItemsService.getIssueDetail(
      fx.projectId,
      blocker.identifier,
      fx.ctx,
    );
    expect(blockerDetail.blocks.map((b) => b.identifier)).toEqual([task.identifier]);
    expect(blockerDetail.blockedBy).toEqual([]);
  });

  it('a top-level item with no children returns parent=null, children=[]', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Lonely epic' },
      fx.ctx,
    );
    const detail = await workItemsService.getIssueDetail(fx.projectId, epic.identifier, fx.ctx);
    expect(detail.parent).toBeNull();
    expect(detail.children).toEqual([]);
    expect(detail.blockedBy).toEqual([]);
  });

  it('a cross-workspace or unknown identifier → WorkItemNotFoundError (no existence leak)', async () => {
    const fxA = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fxA.projectId, kind: 'task', title: 'Private' },
      fxA.ctx,
    );
    const fxB = await makeWorkItemFixture();

    // fxB's context reading fxA's project + identifier → 404.
    await expect(
      workItemsService.getIssueDetail(fxA.projectId, item.identifier, fxB.ctx),
    ).rejects.toThrow(WorkItemNotFoundError);
    // A never-existed identifier → 404.
    await expect(
      workItemsService.getIssueDetail(fxA.projectId, 'PROD-9999', fxA.ctx),
    ).rejects.toThrow(WorkItemNotFoundError);
  });
});
