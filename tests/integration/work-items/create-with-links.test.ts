import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { CrossWorkspaceLinkError, WorkItemLinkCycleError } from '@/lib/workItems/linkErrors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { makeWorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';

// Subtask 2.4.10 — links collected in the create modal, written ATOMICALLY with
// the issue (inside createWorkItem's transaction). Real Postgres, no mocks: the
// cycle / workspace triggers are exercised for real, so the rollback assertions
// prove the item is never born half-linked. The (relationship → directed edge)
// mapping (incl. the `blocks` from/to flip) is the shipped `relationshipToLink`
// single source of truth; here we assert the service applies it once the new id
// exists.

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('createWorkItem with links (2.4.10)', () => {
  it('writes a blocked_by + a relates_to (with reciprocal) atomically with the issue', async () => {
    const fx = await makeWorkItemFixture();
    const blocker = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Blocker' },
      fx.ctx,
    );
    const related = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Related' },
      fx.ctx,
    );

    const issue = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Depends on the blocker',
        links: [
          { targetId: blocker.id, relationship: 'blocked_by' },
          { targetId: related.id, relationship: 'relates_to' },
        ],
      },
      fx.ctx,
    );

    const links = await db.workItemLink.findMany({ orderBy: { createdAt: 'asc' } });
    // is_blocked_by stored as new → blocker; relates_to stored both directions.
    expect(links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromId: issue.id, toId: blocker.id, kind: 'is_blocked_by' }),
        expect.objectContaining({ fromId: issue.id, toId: related.id, kind: 'relates_to' }),
        expect.objectContaining({ fromId: related.id, toId: issue.id, kind: 'relates_to' }),
      ]),
    );
    expect(links).toHaveLength(3);

    // The new item is now blocked by the (non-terminal) blocker.
    const readiness = await workItemsService.getReadiness(issue.id, fx.ctx);
    expect(readiness.ready).toBe(false);
    expect(readiness.openBlockerIds.has(blocker.id)).toBe(true);
  });

  it('flips the from/to direction for a `blocks` relationship', async () => {
    const fx = await makeWorkItemFixture();
    const target = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Downstream' },
      fx.ctx,
    );

    const issue = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'The blocker',
        links: [{ targetId: target.id, relationship: 'blocks' }],
      },
      fx.ctx,
    );

    // "issue blocks target" is stored as "target is_blocked_by issue".
    const links = await db.workItemLink.findMany();
    expect(links).toEqual([
      expect.objectContaining({ fromId: target.id, toId: issue.id, kind: 'is_blocked_by' }),
    ]);
    // So `target` is the one that's now blocked, not the new issue.
    expect((await workItemsService.getReadiness(issue.id, fx.ctx)).ready).toBe(true);
    expect((await workItemsService.getReadiness(target.id, fx.ctx)).ready).toBe(false);
  });

  it('rolls back the WHOLE create when a link would close a cycle (atomic)', async () => {
    const fx = await makeWorkItemFixture();
    const other = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Other' },
      fx.ctx,
    );

    // blocked_by + blocks the SAME issue → new is_blocked_by other AND
    // other is_blocked_by new → a 2-cycle the trigger rejects on the 2nd edge.
    await expect(
      workItemsService.createWorkItem(
        {
          projectId: fx.projectId,
          kind: 'task',
          title: 'Cyclic issue',
          links: [
            { targetId: other.id, relationship: 'blocked_by' },
            { targetId: other.id, relationship: 'blocks' },
          ],
        },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(WorkItemLinkCycleError);

    // Nothing persisted: no "Cyclic issue" row, no links at all (the first edge
    // rolled back with the item).
    expect(await db.workItem.findFirst({ where: { title: 'Cyclic issue' } })).toBeNull();
    expect(await db.workItemLink.count()).toBe(0);
  });

  it('rolls back when a link target is in another workspace', async () => {
    const ws1 = await makeWorkItemFixture({ name: 'One', identifier: 'ONE' });
    const ws2 = await makeWorkItemFixture({ name: 'Two', identifier: 'TWO' });
    const foreign = await workItemsService.createWorkItem(
      { projectId: ws2.projectId, kind: 'task', title: 'Foreign' },
      ws2.ctx,
    );

    await expect(
      workItemsService.createWorkItem(
        {
          projectId: ws1.projectId,
          kind: 'task',
          title: 'Cross-tenant issue',
          links: [{ targetId: foreign.id, relationship: 'blocked_by' }],
        },
        ws1.ctx,
      ),
    ).rejects.toBeInstanceOf(CrossWorkspaceLinkError);

    expect(await db.workItem.findFirst({ where: { title: 'Cross-tenant issue' } })).toBeNull();
  });

  it('rolls back when a link target does not exist', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      workItemsService.createWorkItem(
        {
          projectId: fx.projectId,
          kind: 'task',
          title: 'Dangling link issue',
          links: [{ targetId: 'wi_does_not_exist', relationship: 'blocked_by' }],
        },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
    expect(await db.workItem.findFirst({ where: { title: 'Dangling link issue' } })).toBeNull();
  });
});

describe('listCreateLinkCandidates (2.4.10; server-search since 6.9.2)', () => {
  it('returns the workspace items matching the query (cross-project) and excludes archived ones', async () => {
    const fx = await makeWorkItemFixture();
    const a = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Candidate A node' },
      fx.ctx,
    );
    const archived = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Archived node' },
      fx.ctx,
    );
    await db.workItem.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });

    // Query-driven since 6.9.2 — both titles share the "node" token; the archived
    // one is still filtered out by the read.
    const candidates = await workItemsService.listCreateLinkCandidates('node', fx.ctx);
    const ids = candidates.map((c) => c.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(archived.id);
  });

  it("does not surface another workspace's items", async () => {
    const ws1 = await makeWorkItemFixture({ name: 'One', identifier: 'ONE' });
    const ws2 = await makeWorkItemFixture({ name: 'Two', identifier: 'TWO' });
    const foreign = await workItemsService.createWorkItem(
      { projectId: ws2.projectId, kind: 'task', title: 'Foreign node' },
      ws2.ctx,
    );

    const candidates = await workItemsService.listCreateLinkCandidates('node', ws1.ctx);
    expect(candidates.map((c) => c.id)).not.toContain(foreign.id);
  });
});
