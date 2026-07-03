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

  // Subtask 7.20.6 / MOTIR-1013 — the per-container PROGRESS roll-up.
  it('carries a subtree progress roll-up on CONTAINER nodes; leaves carry null', async () => {
    const fx = await makeFixture();
    const f = await buildForest(fx);

    // Roots: Epic E (a container) + Bug X (a leaf root).
    const roots = await workItemsService.getProjectRoadmap(fx.projectId, null, fx.ctx);
    const rootById = new Map(roots.nodes.map((n) => [n.identifier, n]));
    // E's subtree (depth>1): A, A1(done), A2(todo), B, B1(done), B2(cancelled), B3(in_review).
    // total EXCLUDES the cancelled B2 → 6; done = A1 + B1 = 2 (stories/in_review are not done).
    expect(rootById.get('PROD-1')!.progress).toEqual({ done: 2, total: 6, verified: 0 });
    expect(rootById.get('PROD-9')!.progress).toBeNull(); // Bug X is a leaf → no meter

    // Story level under E: each story rolls up its own subtasks.
    const stories = await workItemsService.getProjectRoadmap(fx.projectId, f.E.id, fx.ctx);
    const storyById = new Map(stories.nodes.map((n) => [n.identifier, n]));
    expect(storyById.get('PROD-2')!.progress).toEqual({ done: 1, total: 2, verified: 0 }); // A: A1 done / A1,A2
    expect(storyById.get('PROD-5')!.progress).toEqual({ done: 1, total: 2, verified: 0 }); // B: B1 done / B1,B3 (B2 cancelled excl.)

    // Leaf level under Story A: both subtasks are leaves → null progress.
    const leaves = await workItemsService.getProjectRoadmap(fx.projectId, f.A.id, fx.ctx);
    expect(leaves.nodes.map((n) => n.progress)).toEqual([null, null]);
  });

  it('a container whose only live descendant is cancelled rolls up to 0 / 0 (no meter)', async () => {
    const fx = await makeFixture();
    const S = await createWorkItem(fx, { kind: 'story', title: 'Lonely story' });
    const S1 = await createWorkItem(fx, { kind: 'subtask', title: 'Only child', parentId: S.id });
    await setStatus(S1.id, 'cancelled');

    const roots = await workItemsService.getProjectRoadmap(fx.projectId, null, fx.ctx);
    const s = roots.nodes.find((n) => n.id === S.id)!;
    expect(s.hasChildren).toBe(true); // a non-archived child exists…
    expect(s.progress).toEqual({ done: 0, total: 0, verified: 0 }); // …but cancelled is excluded from both
  });

  it('progress excludes ARCHIVED descendants', async () => {
    const fx = await makeFixture();
    const f = await buildForest(fx);
    // Archive A2 (todo) — E's total drops from 6 to 5; done unchanged.
    await db.workItem.update({ where: { id: f.A2.id }, data: { archivedAt: new Date() } });

    const roots = await workItemsService.getProjectRoadmap(fx.projectId, null, fx.ctx);
    const e = roots.nodes.find((n) => n.identifier === 'PROD-1')!;
    expect(e.progress).toEqual({ done: 2, total: 5, verified: 0 });
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
      {
        id: f.B1.id,
        identifier: 'PROD-6',
        title: 'Subtask B1',
        parentTitle: 'Story B',
        // Enriched for the sprint-validity signal (MOTIR-1379); in project scope
        // `inActiveSprint` is always false (no sprint resolved).
        isDone: true,
        inActiveSprint: false,
      },
    ]);
  });

  it('a level with no blocked_by links → no edges', async () => {
    const fx = await makeFixture();
    const f = await buildForest(fx);
    const { edges } = await workItemsService.getProjectRoadmap(fx.projectId, f.B.id, fx.ctx);
    expect(edges).toEqual([]);
  });
});
