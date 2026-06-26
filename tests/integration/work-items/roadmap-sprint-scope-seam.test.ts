import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { truncateAuthTables } from '../../helpers/db';
import {
  makeWorkItemFixture as makeFixture,
  createTestWorkItem as createWorkItem,
  createTestLink,
} from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures';

// STORY-LEVEL INTEGRATION SEAM (MOTIR-1383) for the sprint-scoped roadmap read.
// Drives the ASSEMBLED `workItemsService.getProjectRoadmap(..., { scope: 'sprint' })`
// DTO — the shape `fetchRoadmapLevel` actually consumes — over a tree seeded
// across sprint-membership boundaries. This verifies the SERVICE wires the active
// sprint + the member-or-ancestor repo read + the scoped progress + the edges into
// ONE coherent DTO (the drift the per-subtask units mask), NOT a repeat of those
// units (the repo-method assertions live in `roadmap-sprint-scope.test.ts`,
// notes.html #102). Real Postgres, no mocks (Yue's rule).

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_revision", "work_item_link", "work_item", "sprint" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
});

async function createActiveSprint(fx: WorkItemFixture, name = 'Sprint 1'): Promise<string> {
  const sprint = await db.sprint.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      name,
      state: 'active',
      sequence: 1,
    },
  });
  return sprint.id;
}
async function setSprint(id: string, sprintId: string | null): Promise<void> {
  await db.workItem.update({ where: { id }, data: { sprintId } });
}
async function setStatus(id: string, status: string): Promise<void> {
  await db.workItem.update({ where: { id }, data: { status } });
}
/** `is_blocked_by`: from = the blocked item, to = the blocker (mirrors project-roadmap.test). */
async function link(fx: WorkItemFixture, blockedId: string, blockerId: string): Promise<void> {
  await createTestLink({
    workspaceId: fx.workspaceId,
    fromId: blockedId,
    toId: blockerId,
    kind: 'is_blocked_by',
    createdById: fx.ownerId,
  });
}

/**
 * The seam tree (membership boundaries + edges):
 *   Epic A
 *     ├─ Story A1 (blocked_by Story A3) ─ a1 (IN sprint, done) · a2 (backlog)
 *     ├─ Story A2 (entirely backlog)
 *     └─ Story A3 (IN sprint itself — story-grain membership; no children)
 *   Epic B
 *     └─ Story B1 ─ b1 (backlog) — Epic B has NO in-sprint descendant
 * Members: a1, A3 → member-or-ancestor set = { a1, A3, Story A1, Epic A }.
 */
async function seedTree(fx: WorkItemFixture, sprintId: string) {
  const epicA = await createWorkItem(fx, { kind: 'epic', title: 'Epic A' });
  const storyA1 = await createWorkItem(fx, {
    kind: 'story',
    title: 'Story A1',
    parentId: epicA.id,
  });
  const a1 = await createWorkItem(fx, { kind: 'subtask', title: 'a1', parentId: storyA1.id });
  const a2 = await createWorkItem(fx, { kind: 'subtask', title: 'a2', parentId: storyA1.id });
  const storyA2 = await createWorkItem(fx, {
    kind: 'story',
    title: 'Story A2',
    parentId: epicA.id,
  });
  const storyA3 = await createWorkItem(fx, {
    kind: 'story',
    title: 'Story A3',
    parentId: epicA.id,
  });
  const epicB = await createWorkItem(fx, { kind: 'epic', title: 'Epic B' });
  const storyB1 = await createWorkItem(fx, {
    kind: 'story',
    title: 'Story B1',
    parentId: epicB.id,
  });
  const b1 = await createWorkItem(fx, { kind: 'subtask', title: 'b1', parentId: storyB1.id });

  await setSprint(a1.id, sprintId);
  await setSprint(storyA3.id, sprintId);
  await setStatus(a1.id, 'done');
  // Within-level edge under Epic A: Story A1 blocked_by Story A3 (both in scope).
  await link(fx, storyA1.id, storyA3.id);

  return { epicA, storyA1, a1, a2, storyA2, storyA3, epicB, storyB1, b1 };
}

describe('getProjectRoadmap seam — sprint scope', () => {
  it('case 1 — ROOT level returns only the epic that contains/ is in-sprint work; Epic B absent', async () => {
    const fx = await makeFixture();
    const sprintId = await createActiveSprint(fx);
    const t = await seedTree(fx, sprintId);

    const roadmap = await workItemsService.getProjectRoadmap(fx.projectId, null, fx.ctx, {
      scope: 'sprint',
    });
    expect(roadmap.nodes.map((n) => n.id)).toEqual([t.epicA.id]);
    expect(roadmap.nodes[0]!.hasChildren).toBe(true);
  });

  it('case 2 — DRILL Story A1 returns only the in-sprint leaf; backlog sibling absent', async () => {
    const fx = await makeFixture();
    const sprintId = await createActiveSprint(fx);
    const t = await seedTree(fx, sprintId);

    const roadmap = await workItemsService.getProjectRoadmap(fx.projectId, t.storyA1.id, fx.ctx, {
      scope: 'sprint',
    });
    expect(roadmap.nodes.map((n) => n.id)).toEqual([t.a1.id]);
    expect(roadmap.nodes[0]!.hasChildren).toBe(false);
  });

  it('case 3 — PROGRESS counts only in-sprint descendants', async () => {
    const fx = await makeFixture();
    const sprintId = await createActiveSprint(fx);
    const t = await seedTree(fx, sprintId);

    // Epic A (root) in-sprint descendants: a1 (done) + Story A3 (todo) → 1 / 2.
    const root = await workItemsService.getProjectRoadmap(fx.projectId, null, fx.ctx, {
      scope: 'sprint',
    });
    expect(root.nodes.find((n) => n.id === t.epicA.id)!.progress).toEqual({ done: 1, total: 2 });

    // Story A1's only in-sprint descendant is a1 (done) → 1 / 1; member-leaf A3 → null.
    const children = await workItemsService.getProjectRoadmap(fx.projectId, t.epicA.id, fx.ctx, {
      scope: 'sprint',
    });
    expect(children.nodes.find((n) => n.id === t.storyA1.id)!.progress).toEqual({
      done: 1,
      total: 1,
    });
    expect(children.nodes.find((n) => n.id === t.storyA3.id)!.progress).toBeNull();
  });

  it('exercises within-level is_blocked_by edges UNDER sprint scope', async () => {
    const fx = await makeFixture();
    const sprintId = await createActiveSprint(fx);
    const t = await seedTree(fx, sprintId);

    const children = await workItemsService.getProjectRoadmap(fx.projectId, t.epicA.id, fx.ctx, {
      scope: 'sprint',
    });
    // The Epic-A child level under scope is [Story A1, Story A3]; the A1→A3 edge holds.
    expect(children.nodes.map((n) => n.id).sort()).toEqual([t.storyA1.id, t.storyA3.id].sort());
    expect(children.edges).toEqual([{ blockedId: t.storyA1.id, blockerId: t.storyA3.id }]);
  });

  it('case 4 — whole-project parity: scope:project equals the pre-existing read (full tree)', async () => {
    const fx = await makeFixture();
    const sprintId = await createActiveSprint(fx);
    const t = await seedTree(fx, sprintId);

    const preExisting = await workItemsService.getProjectRoadmap(fx.projectId, null, fx.ctx);
    const projectScope = await workItemsService.getProjectRoadmap(fx.projectId, null, fx.ctx, {
      scope: 'project',
    });
    expect(projectScope).toEqual(preExisting);
    expect(projectScope.nodes.map((n) => n.id).sort()).toEqual([t.epicA.id, t.epicB.id].sort());
  });

  it('case 5 — no active sprint → empty roadmap (no throw)', async () => {
    const fx = await makeFixture();
    const sprintId = await createActiveSprint(fx);
    await seedTree(fx, sprintId);
    // Complete the sprint so none is active.
    await db.sprint.update({ where: { id: sprintId }, data: { state: 'complete' } });

    const roadmap = await workItemsService.getProjectRoadmap(fx.projectId, null, fx.ctx, {
      scope: 'sprint',
    });
    expect(roadmap).toEqual({ nodes: [], edges: [], offLevelBlockers: [] });
  });

  it('case 6 — tenant gate is NOT bypassed by sprint scope', async () => {
    const fx = await makeFixture();
    const sprintId = await createActiveSprint(fx);
    await seedTree(fx, sprintId);
    const other = await makeFixture({ name: 'Other', identifier: 'OTHR' });

    // fx's project id read under the OTHER workspace's context → not found.
    await expect(
      workItemsService.getProjectRoadmap(fx.projectId, null, other.ctx, { scope: 'sprint' }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});
