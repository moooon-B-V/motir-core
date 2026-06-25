import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { truncateAuthTables } from '../../helpers/db';
import {
  makeWorkItemFixture as makeFixture,
  createTestWorkItem as createWorkItem,
  type WorkItemFixture,
} from '../../fixtures';

// Integration tests for the project ROADMAP read (Subtask 7.20.4 re-plan,
// MOTIR-1010): workItemsService.getProjectRoadmap — now a PER-LEVEL read (the
// roots, or one parent's direct children) with a lazy `hasChildren` drill flag +
// the `is_blocked_by` edges FROM that level, reusing `findProjectTreeLevel`. The
// canvas (MOTIR-1194) fetches one level at a time on drill; per-container progress
// meters moved to MOTIR-1013 (they need the subtree, which a level read avoids).
// Real Postgres, no mocks (Yue's rule).

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

/** Direct column poke (tests may reach the db to set state — CLAUDE.md). */
async function setStatus(id: string, status: string): Promise<void> {
  await db.workItem.update({ where: { id }, data: { status } });
}

async function link(fx: WorkItemFixture, blockedId: string, blockerId: string): Promise<void> {
  await db.workItemLink.create({
    data: {
      fromId: blockedId, // `is_blocked_by`: from = the blocked item, to = the blocker
      toId: blockerId,
      kind: 'is_blocked_by',
      workspaceId: fx.workspaceId,
      createdById: fx.ctx.userId,
    },
  });
}

/**
 * Build the canonical roadmap test forest in one fixture's project:
 *
 *   E  (epic, root)
 *   ├─ A  (story)  ├─ A1 (subtask) done   └─ A2 (subtask) todo
 *   └─ B  (story)  ├─ B1 (subtask) done   ├─ B2 (subtask) cancelled   └─ B3 (subtask) in_review
 *   X  (bug, root, leaf) done
 *
 * Keys allocate in creation order (E=1, A=2, A1=3, A2=4, B=5, B1=6, B2=7, B3=8, X=9).
 */
async function buildForest(fx: WorkItemFixture) {
  const E = await createWorkItem(fx, { kind: 'epic', title: 'Epic E' });
  const A = await createWorkItem(fx, { kind: 'story', title: 'Story A', parentId: E.id });
  const A1 = await createWorkItem(fx, { kind: 'subtask', title: 'Subtask A1', parentId: A.id });
  const A2 = await createWorkItem(fx, { kind: 'subtask', title: 'Subtask A2', parentId: A.id });
  const B = await createWorkItem(fx, { kind: 'story', title: 'Story B', parentId: E.id });
  const B1 = await createWorkItem(fx, { kind: 'subtask', title: 'Subtask B1', parentId: B.id });
  const B2 = await createWorkItem(fx, { kind: 'subtask', title: 'Subtask B2', parentId: B.id });
  const B3 = await createWorkItem(fx, { kind: 'subtask', title: 'Subtask B3', parentId: B.id });
  const X = await createWorkItem(fx, { kind: 'bug', title: 'Bug X' });

  await setStatus(A1.id, 'done');
  await setStatus(A2.id, 'todo');
  await setStatus(B1.id, 'done');
  await setStatus(B2.id, 'cancelled');
  await setStatus(B3.id, 'in_review');
  await setStatus(X.id, 'done');
  return { E, A, A1, A2, B, B1, B2, B3, X };
}

describe('workItemsService.getProjectRoadmap — per-level read', () => {
  it('roots level (parentId null): the root nodes key-asc, with hasChildren + isDone', async () => {
    const fx = await makeFixture();
    await buildForest(fx);

    const { nodes } = await workItemsService.getProjectRoadmap(fx.projectId, null, fx.ctx);

    // Two roots, key-asc: Epic E (PROD-1) then Bug X (PROD-9).
    expect(nodes.map((n) => n.identifier)).toEqual(['PROD-1', 'PROD-9']);
    const e = nodes[0]!;
    expect(e.kind).toBe('epic');
    expect(e.hasChildren).toBe(true);
    expect(e.isDone).toBe(false); // epic E own status todo
    const x = nodes[1]!;
    expect(x.kind).toBe('bug');
    expect(x.hasChildren).toBe(false); // a leaf root
    expect(x.isDone).toBe(true); // X done
  });

  it("a parent's children level returns its DIRECT children only, key-asc", async () => {
    const fx = await makeFixture();
    const f = await buildForest(fx);

    const { nodes } = await workItemsService.getProjectRoadmap(fx.projectId, f.E.id, fx.ctx);
    expect(nodes.map((n) => n.identifier)).toEqual(['PROD-2', 'PROD-5']); // Story A, Story B
    expect(nodes.every((n) => n.kind === 'story')).toBe(true);
    expect(nodes.every((n) => n.hasChildren)).toBe(true);
  });

  it('resolves isDone by done CATEGORY at the leaf level (in_review / cancelled are NOT done)', async () => {
    const fx = await makeFixture();
    const f = await buildForest(fx);

    const a = await workItemsService.getProjectRoadmap(fx.projectId, f.A.id, fx.ctx);
    expect(a.nodes.map((n) => [n.identifier, n.isDone, n.hasChildren])).toEqual([
      ['PROD-3', true, false], // A1 done, leaf
      ['PROD-4', false, false], // A2 todo, leaf
    ]);

    const b = await workItemsService.getProjectRoadmap(fx.projectId, f.B.id, fx.ctx);
    const byId = new Map(b.nodes.map((n) => [n.identifier, n]));
    expect(byId.get('PROD-7')!.isDone).toBe(false); // B2 cancelled — NOT done
    expect(byId.get('PROD-8')!.isDone).toBe(false); // B3 in_review — NOT done
  });

  it('excludes archived items from the level', async () => {
    const fx = await makeFixture();
    const f = await buildForest(fx);
    await db.workItem.update({ where: { id: f.B.id }, data: { archivedAt: new Date() } });

    const { nodes } = await workItemsService.getProjectRoadmap(fx.projectId, f.E.id, fx.ctx);
    expect(nodes.map((n) => n.identifier)).toEqual(['PROD-2']); // Story B archived out
  });

  it('empty level → { nodes: [], edges: [], offLevelBlockers: [] }', async () => {
    const fx = await makeFixture();
    expect(await workItemsService.getProjectRoadmap(fx.projectId, null, fx.ctx)).toEqual({
      nodes: [],
      edges: [],
      offLevelBlockers: [],
    });
  });

  it('a cross-workspace projectId is a ProjectNotFoundError (no existence leak)', async () => {
    const fxA = await makeFixture({ name: 'Acme', identifier: 'AAA' });
    const fxB = await makeFixture({ name: 'Other', identifier: 'BBB' });
    await expect(
      workItemsService.getProjectRoadmap(fxA.projectId, null, fxB.ctx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('workItemsService.getProjectRoadmap — dependency edges (per level)', () => {
  it('returns the within-level is_blocked_by edges from the level items', async () => {
    const fx = await makeFixture();
    const f = await buildForest(fx);
    await link(fx, f.A2.id, f.A1.id); // A2 blocked_by A1, both under Story A

    const lvl = await workItemsService.getProjectRoadmap(fx.projectId, f.A.id, fx.ctx);
    expect(lvl.edges).toEqual([{ blockedId: f.A2.id, blockerId: f.A1.id }]);
    expect(lvl.offLevelBlockers).toEqual([]); // both ends on this level — no anchor
  });

  it('returns an OFF-level blocker edge + a naming STUB for the cross-story anchor', async () => {
    const fx = await makeFixture();
    const f = await buildForest(fx);
    await link(fx, f.A2.id, f.B1.id); // A2 (Story A) blocked_by B1 (Story B) — cross-story

    // The edge is returned FROM this level (blocked end A2 ∈ level); its blocker is
    // off-level → the canvas anchors a red signal to a chip naming it.
    const lvl = await workItemsService.getProjectRoadmap(fx.projectId, f.A.id, fx.ctx);
    expect(lvl.edges).toEqual([{ blockedId: f.A2.id, blockerId: f.B1.id }]);
    expect(lvl.offLevelBlockers).toEqual([
      { id: f.B1.id, identifier: 'PROD-6', title: 'Subtask B1', parentTitle: 'Story B' },
    ]);
  });

  it('a level with no blocked_by links → no edges', async () => {
    const fx = await makeFixture();
    const f = await buildForest(fx);
    const { edges } = await workItemsService.getProjectRoadmap(fx.projectId, f.B.id, fx.ctx);
    expect(edges).toEqual([]);
  });
});
