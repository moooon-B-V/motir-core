import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
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
    // Ancestor breadcrumb chain: root→self, item excluded (the task's lineage
    // is Epic → Story). `parent` is the chain's last element.
    expect(detail.ancestors.map((a) => a.identifier)).toEqual([epic.identifier, story.identifier]);
    expect(detail.ancestors.at(-1)?.identifier).toBe(detail.parent?.identifier);
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

    // The deepest item walks the full 3-ancestor chain (Epic → Story → Task),
    // root→self; its own child list is empty (a leaf shows nothing).
    const subtaskDetail = await workItemsService.getIssueDetail(
      fx.projectId,
      subtask.identifier,
      fx.ctx,
    );
    expect(subtaskDetail.ancestors.map((a) => a.identifier)).toEqual([
      epic.identifier,
      story.identifier,
      task.identifier,
    ]);
    expect(subtaskDetail.children).toEqual([]);
  });

  it('a top-level item with no children returns parent=null, children=[]', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Lonely epic' },
      fx.ctx,
    );
    const detail = await workItemsService.getIssueDetail(fx.projectId, epic.identifier, fx.ctx);
    expect(detail.parent).toBeNull();
    expect(detail.ancestors).toEqual([]); // top-level → no breadcrumb
    expect(detail.children).toEqual([]);
    expect(detail.blockedBy).toEqual([]);
  });

  it('findAncestors is workspace-scoped — a foreign workspaceId yields no chain', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Epic' },
      fx.ctx,
    );
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Story', parentId: epic.id },
      fx.ctx,
    );

    // Correct workspace → the chain resolves (root→self).
    const own = await workItemRepository.findAncestors(story.id, fx.ctx.workspaceId);
    expect(own.map((a) => a.identifier)).toEqual([epic.identifier]);

    // A different workspace's id filters out even the anchor row, so a
    // cross-tenant probe gets an empty chain — no ancestor identifiers/titles
    // leak across workspaces.
    const otherWs = await makeWorkItemFixture();
    const foreign = await workItemRepository.findAncestors(story.id, otherWs.ctx.workspaceId);
    expect(foreign).toEqual([]);
  });

  // --- 2.4.5: relationship grouping + the readiness verdict ----------------

  it('groups links by kind (blocked-by / blocks / relates-to / duplicates / clones) + verdict is "blocked" while a blocker is open', async () => {
    const fx = await makeWorkItemFixture();
    const make = (title: string) =>
      workItemsService.createWorkItem({ projectId: fx.projectId, kind: 'task', title }, fx.ctx);

    const subject = await make('Subject');
    const blocker = await make('Upstream blocker');
    const blocked = await make('Downstream blocked');
    const related = await make('Related');
    const dup = await make('Duplicate');
    const clone = await make('Clone source');

    // subject is_blocked_by blocker  → blockedBy
    await workItemsService.linkWorkItems(
      { fromId: subject.id, toId: blocker.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    // blocked is_blocked_by subject  → subject "blocks" blocked (reverse edge)
    await workItemsService.linkWorkItems(
      { fromId: blocked.id, toId: subject.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    await workItemsService.linkWorkItems(
      { fromId: subject.id, toId: related.id, kind: 'relates_to' },
      fx.ctx,
    );
    await workItemsService.linkWorkItems(
      { fromId: subject.id, toId: dup.id, kind: 'duplicates' },
      fx.ctx,
    );
    await workItemsService.linkWorkItems(
      { fromId: subject.id, toId: clone.id, kind: 'clones' },
      fx.ctx,
    );

    const detail = await workItemsService.getIssueDetail(fx.projectId, subject.identifier, fx.ctx);
    expect(detail.blockedBy.map((b) => b.identifier)).toEqual([blocker.identifier]);
    expect(detail.blocks.map((b) => b.identifier)).toEqual([blocked.identifier]);
    expect(detail.relatesTo.map((b) => b.identifier)).toEqual([related.identifier]);
    expect(detail.duplicates.map((b) => b.identifier)).toEqual([dup.identifier]);
    expect(detail.clones.map((b) => b.identifier)).toEqual([clone.identifier]);

    // The blocker is still in its initial (non-terminal) status → blocked, and
    // the verdict NAMES the open blocker so the badge reads "Blocked by <id>".
    expect(detail.readiness.ready).toBe(false);
    expect(detail.readiness.openBlockers.map((b) => b.identifier)).toEqual([blocker.identifier]);
  });

  it('readiness flips to "ready" (empty openBlockers) once every blocker is terminal — cancelled counts (finding #21)', async () => {
    const fx = await makeWorkItemFixture();
    const subject = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Subject' },
      fx.ctx,
    );
    const blocker = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Blocker' },
      fx.ctx,
    );
    await workItemsService.linkWorkItems(
      { fromId: subject.id, toId: blocker.id, kind: 'is_blocked_by' },
      fx.ctx,
    );

    const blockedView = await workItemsService.getIssueDetail(
      fx.projectId,
      subject.identifier,
      fx.ctx,
    );
    expect(blockedView.readiness.ready).toBe(false);

    // `cancelled` is category=done in the default-seeded workflow, so a
    // cancelled blocker is terminal → the verdict flips on the next read.
    await db.workItem.update({ where: { id: blocker.id }, data: { status: 'cancelled' } });
    const readyView = await workItemsService.getIssueDetail(
      fx.projectId,
      subject.identifier,
      fx.ctx,
    );
    expect(readyView.readiness.ready).toBe(true);
    expect(readyView.readiness.openBlockers).toEqual([]);
    // Still listed as a relationship — resolved, but the edge is unchanged.
    expect(readyView.blockedBy.map((b) => b.identifier)).toEqual([blocker.identifier]);
  });

  it('an item with no links → every group empty + a trivially-ready verdict', async () => {
    const fx = await makeWorkItemFixture();
    const lonely = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Lonely' },
      fx.ctx,
    );
    const detail = await workItemsService.getIssueDetail(fx.projectId, lonely.identifier, fx.ctx);
    expect(detail.blockedBy).toEqual([]);
    expect(detail.blocks).toEqual([]);
    expect(detail.relatesTo).toEqual([]);
    expect(detail.duplicates).toEqual([]);
    expect(detail.clones).toEqual([]);
    expect(detail.readiness).toEqual({ ready: true, openBlockers: [] });
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
