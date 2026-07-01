import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { commentsService } from '@/lib/services/commentsService';
import { aiBoundaryService } from '@/lib/services/aiBoundaryService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import {
  makeWorkItemFixture as makeFixture,
  createTestProject,
  createTestLink,
} from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';

// Subtask 7.5.1 — the plan-tree GRAPH-TRAVERSAL read family (get_item /
// get_subtree / walk_blocking) at the service level, against a REAL Postgres.
// Proves the DEPTH reads the planner walks: bounded (depth-clamped subtree,
// node/-depth-capped blocking closure, paginated comments + history), cycle-safe,
// and 404-not-403 across tenants (finding #26).

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

describe('workItemsService.getBoundedSubtree', () => {
  it('bounds the subtree to `depth` descendant levels', async () => {
    const fx = await makeFixture();
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Epic' },
      fx.ctx,
    );
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Story', parentId: epic.id },
      fx.ctx,
    );
    const sub = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'subtask', title: 'Sub', parentId: story.id },
      fx.ctx,
    );

    // depth 0 → the root alone.
    const d0 = await workItemsService.getBoundedSubtree(epic.id, fx.ctx, 0);
    expect(d0.depth).toBe(0);
    expect(d0.nodes.map((n) => n.identifier)).toEqual([epic.identifier]);

    // depth 1 → root + direct children (the story), NOT the grandchild subtask.
    const d1 = await workItemsService.getBoundedSubtree(epic.id, fx.ctx, 1);
    expect(d1.nodes.map((n) => n.identifier).sort()).toEqual(
      [epic.identifier, story.identifier].sort(),
    );

    // depth 2 → the whole three-level chain.
    const d2 = await workItemsService.getBoundedSubtree(epic.id, fx.ctx, 2);
    expect(d2.nodes.map((n) => n.identifier).sort()).toEqual(
      [epic.identifier, story.identifier, sub.identifier].sort(),
    );
  });

  it('clamps an omitted / oversized depth (never a whole-tree read)', async () => {
    const fx = await makeFixture();
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Epic' },
      fx.ctx,
    );

    const dflt = await workItemsService.getBoundedSubtree(epic.id, fx.ctx); // omitted → default 2
    expect(dflt.depth).toBe(2);

    const clamped = await workItemsService.getBoundedSubtree(epic.id, fx.ctx, 999); // → max 10
    expect(clamped.depth).toBe(10);
  });

  it('404s (WorkItemNotFoundError) a cross-tenant root', async () => {
    const a = await makeFixture();
    const b = await makeFixture();
    const bEpic = await workItemsService.createWorkItem(
      { projectId: b.projectId, kind: 'epic', title: 'B' },
      b.ctx,
    );
    await expect(workItemsService.getBoundedSubtree(bEpic.id, a.ctx)).rejects.toBeInstanceOf(
      WorkItemNotFoundError,
    );
  });
});

describe('workItemsService.getBlockingClosure', () => {
  // Helper: make `from` is_blocked_by `to` (a dependency edge).
  async function blockedBy(
    fx: Awaited<ReturnType<typeof makeFixture>>,
    fromId: string,
    toId: string,
  ) {
    await createTestLink({
      workspaceId: fx.workspaceId,
      fromId,
      toId,
      kind: 'is_blocked_by',
      createdById: fx.ownerId,
    });
  }

  it('walks the transitive is_blocked_by closure', async () => {
    const fx = await makeFixture();
    const [a, b, c] = await Promise.all([
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'A' },
        fx.ctx,
      ),
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'B' },
        fx.ctx,
      ),
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'C' },
        fx.ctx,
      ),
    ]);
    await blockedBy(fx, a.id, b.id); // A blocked_by B
    await blockedBy(fx, b.id, c.id); // B blocked_by C

    const closure = await workItemsService.getBlockingClosure(a.id, fx.ctx);
    expect(closure.nodes.map((n) => n.identifier).sort()).toEqual(
      [b.identifier, c.identifier].sort(),
    );
    expect(closure.truncated).toBe(false);
    // edges spell A→B and B→C.
    const edgeSet = new Set(closure.edges.map((e) => `${e.blockedId}->${e.blockerId}`));
    expect(edgeSet.has(`${a.id}->${b.id}`)).toBe(true);
    expect(edgeSet.has(`${b.id}->${c.id}`)).toBe(true);
  });

  it('is cycle-safe — the visited-set dedups a node reached by multiple paths', async () => {
    // The core enforces the is_blocked_by graph acyclic (a real A↔B insert is
    // rejected by the DB trigger — WI_LINK_CYCLE), so the visited-set defense is
    // exercised by a DIAMOND: D is reached via BOTH B and C. The second discovery
    // hits the `visited.has` guard — the exact branch that makes a walk terminate
    // on a (hypothetical) cycle: a node is expanded at most once, never looped.
    const fx = await makeFixture();
    const [a, b, c, d] = await Promise.all([
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'A' },
        fx.ctx,
      ),
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'B' },
        fx.ctx,
      ),
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'C' },
        fx.ctx,
      ),
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'D' },
        fx.ctx,
      ),
    ]);
    await blockedBy(fx, a.id, b.id); // A blocked_by B
    await blockedBy(fx, a.id, c.id); // A blocked_by C
    await blockedBy(fx, b.id, d.id); // B blocked_by D
    await blockedBy(fx, c.id, d.id); // C blocked_by D  (D reached twice)

    const closure = await workItemsService.getBlockingClosure(a.id, fx.ctx);
    // D appears exactly once despite two paths to it; the walk terminates.
    expect(closure.nodes.map((n) => n.identifier).sort()).toEqual(
      [b.identifier, c.identifier, d.identifier].sort(),
    );
    expect(closure.nodes.filter((n) => n.identifier === d.identifier)).toHaveLength(1);
    expect(closure.truncated).toBe(false);
  });

  it('node-caps the closure and flags `truncated`', async () => {
    const fx = await makeFixture();
    const [a, b, c] = await Promise.all([
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'A' },
        fx.ctx,
      ),
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'B' },
        fx.ctx,
      ),
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'C' },
        fx.ctx,
      ),
    ]);
    await blockedBy(fx, a.id, b.id);
    await blockedBy(fx, b.id, c.id);

    const closure = await workItemsService.getBlockingClosure(a.id, fx.ctx, { maxNodes: 2 });
    // root(1) + B(2) reaches the cap; C is dropped.
    expect(closure.nodes.map((n) => n.identifier)).toEqual([b.identifier]);
    expect(closure.truncated).toBe(true);
  });

  it('depth-caps the walk and flags `truncated`', async () => {
    const fx = await makeFixture();
    const [a, b, c] = await Promise.all([
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'A' },
        fx.ctx,
      ),
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'B' },
        fx.ctx,
      ),
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'C' },
        fx.ctx,
      ),
    ]);
    await blockedBy(fx, a.id, b.id);
    await blockedBy(fx, b.id, c.id);

    const closure = await workItemsService.getBlockingClosure(a.id, fx.ctx, { maxDepth: 1 });
    expect(closure.nodes.map((n) => n.identifier)).toEqual([b.identifier]); // only level 1
    expect(closure.truncated).toBe(true);
  });

  it('excludes a cross-project blocker (reads only the token’s project)', async () => {
    const fx = await makeFixture();
    const otherProject = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTHR',
    });
    const root = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Root' },
      fx.ctx,
    );
    const foreign = await workItemsService.createWorkItem(
      { projectId: otherProject.id, kind: 'story', title: 'Foreign' },
      fx.ctx,
    );
    await createTestLink({
      workspaceId: fx.workspaceId,
      fromId: root.id,
      toId: foreign.id, // same workspace, DIFFERENT project
      kind: 'is_blocked_by',
      createdById: fx.ownerId,
    });

    const closure = await workItemsService.getBlockingClosure(root.id, fx.ctx);
    expect(closure.nodes).toEqual([]); // the cross-project blocker is out of scope
    expect(closure.edges).toEqual([]);
    expect(closure.truncated).toBe(false);
  });

  it('404s a cross-tenant root', async () => {
    const a = await makeFixture();
    const b = await makeFixture();
    const bItem = await workItemsService.createWorkItem(
      { projectId: b.projectId, kind: 'story', title: 'B' },
      b.ctx,
    );
    await expect(workItemsService.getBlockingClosure(bItem.id, a.ctx)).rejects.toBeInstanceOf(
      WorkItemNotFoundError,
    );
  });
});

describe('workItemsService.listRevisionsPage', () => {
  it('cursor-paginates the change log newest-first', async () => {
    const fx = await makeFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'V0' },
      fx.ctx,
    );
    // createWorkItem records a `created` revision; two updates add two more.
    await workItemsService.updateWorkItem(item.id, { title: 'V1' }, fx.ctx);
    await workItemsService.updateWorkItem(item.id, { title: 'V2' }, fx.ctx);

    const page1 = await workItemsService.listRevisionsPage(item.id, fx.ctx, { take: 1 });
    expect(page1.revisions).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await workItemsService.listRevisionsPage(item.id, fx.ctx, {
      take: 1,
      cursor: page1.nextCursor!,
    });
    expect(page2.revisions).toHaveLength(1);
    // distinct revisions across pages (no repeat at the boundary).
    expect(page2.revisions[0]!.id).not.toBe(page1.revisions[0]!.id);

    // A big take returns everything with no next cursor.
    const all = await workItemsService.listRevisionsPage(item.id, fx.ctx);
    expect(all.revisions.length).toBeGreaterThanOrEqual(3);
    expect(all.nextCursor).toBeNull();
  });

  it('404s a cross-tenant work item', async () => {
    const a = await makeFixture();
    const b = await makeFixture();
    const bItem = await workItemsService.createWorkItem(
      { projectId: b.projectId, kind: 'story', title: 'B' },
      b.ctx,
    );
    await expect(workItemsService.listRevisionsPage(bItem.id, a.ctx)).rejects.toBeInstanceOf(
      WorkItemNotFoundError,
    );
  });
});

describe('aiBoundaryService — the graph-traversal boundary', () => {
  it('getItem returns the item, and comments/history only when asked', async () => {
    const fx = await makeFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Item' },
      fx.ctx,
    );
    await commentsService.addComment(item.id, { bodyMd: 'first note' }, fx.ctx);

    const bare = await aiBoundaryService.getItem(fx.projectId, item.identifier, fx.ctx);
    expect(bare.item.identifier).toBe(item.identifier);
    expect(bare.comments).toBeUndefined();
    expect(bare.history).toBeUndefined();

    const rich = await aiBoundaryService.getItem(fx.projectId, item.identifier, fx.ctx, {
      withComments: true,
      withHistory: true,
    });
    expect(rich.comments?.threads).toHaveLength(1);
    expect(rich.history?.revisions.length).toBeGreaterThanOrEqual(1);
  });

  it('getSubtree returns the skeleton neighborhood with parentKey resolved', async () => {
    const fx = await makeFixture();
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Epic' },
      fx.ctx,
    );
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Story', parentId: epic.id },
      fx.ctx,
    );

    const res = await aiBoundaryService.getSubtree(fx.projectId, epic.identifier, 1, fx.ctx);
    expect(res.root).toBe(epic.identifier);
    expect(res.depth).toBe(1);
    const byKey = new Map(res.nodes.map((n) => [n.key, n]));
    expect(byKey.get(epic.identifier)).toMatchObject({ parentKey: null });
    expect(byKey.get(story.identifier)).toMatchObject({ parentKey: epic.identifier });
  });

  it('walkBlocking maps the closure to identifier keys', async () => {
    const fx = await makeFixture();
    const [a, b] = await Promise.all([
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'A' },
        fx.ctx,
      ),
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'B' },
        fx.ctx,
      ),
    ]);
    await createTestLink({
      workspaceId: fx.workspaceId,
      fromId: a.id,
      toId: b.id,
      kind: 'is_blocked_by',
      createdById: fx.ownerId,
    });

    const res = await aiBoundaryService.walkBlocking(fx.projectId, a.identifier, fx.ctx);
    expect(res.root).toBe(a.identifier);
    expect(res.nodes.map((n) => n.key)).toEqual([b.identifier]);
    expect(res.edges).toEqual([{ blockedKey: a.identifier, blockerKey: b.identifier }]);
    expect(res.truncated).toBe(false);
  });
});
