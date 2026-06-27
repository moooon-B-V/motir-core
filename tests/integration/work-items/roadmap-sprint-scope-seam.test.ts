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
// DTO — the shape `fetchRoadmapLevel` consumes — over a tree seeded across sprint
// membership boundaries. The sprint-scoped roadmap is rooted at the TOPMOST in-sprint
// items (a member story, or the in-sprint subtasks of a non-member story); epics and
// non-member ancestors are elided; below a shown member the tree is the normal,
// unscoped read. This verifies the SERVICE wires the active sprint + the root-member
// selection + the (full-subtree) progress + the edges into ONE DTO — NOT a repeat of
// the repo units (notes.html #102). Real Postgres, no mocks (Yue's rule).

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
/** `is_blocked_by`: from = the blocked item, to = the blocker. */
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
 * The seam tree (members = a1, Story A2):
 *   Epic A
 *     ├─ Story A1 (NOT a member) ─ a1 (IN sprint, done; blocked_by Story A2) · a2 (backlog)
 *     ├─ Story A2 (IN sprint)    ─ a3 (backlog, done)
 *   Epic B
 *     └─ Story B1 ─ b1 (backlog) — wholly backlog
 * Topmost in-sprint members ("root members"): { a1, Story A2 }.
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
  const a3 = await createWorkItem(fx, { kind: 'subtask', title: 'a3', parentId: storyA2.id });
  const epicB = await createWorkItem(fx, { kind: 'epic', title: 'Epic B' });
  const storyB1 = await createWorkItem(fx, {
    kind: 'story',
    title: 'Story B1',
    parentId: epicB.id,
  });
  const b1 = await createWorkItem(fx, { kind: 'subtask', title: 'b1', parentId: storyB1.id });

  await setSprint(a1.id, sprintId);
  await setSprint(storyA2.id, sprintId);
  await setStatus(a1.id, 'done');
  await setStatus(a3.id, 'done');
  // A within-(root)-level edge: a1 blocked_by Story A2 (both are root members).
  await link(fx, a1.id, storyA2.id);

  return { epicA, storyA1, a1, a2, storyA2, a3, epicB, storyB1, b1 };
}

describe('getProjectRoadmap seam — sprint scope (top in-sprint roots)', () => {
  it('case 1 — ROOT level is the topmost members; epics and non-member ancestors are elided', async () => {
    const fx = await makeFixture();
    const sprintId = await createActiveSprint(fx);
    const t = await seedTree(fx, sprintId);

    const roadmap = await workItemsService.getProjectRoadmap(fx.projectId, null, fx.ctx, {
      scope: 'sprint',
    });
    expect(roadmap.nodes.map((n) => n.id).sort()).toEqual([t.a1.id, t.storyA2.id].sort());
    expect(roadmap.nodes.find((n) => n.id === t.a1.id)!.hasChildren).toBe(false);
    expect(roadmap.nodes.find((n) => n.id === t.storyA2.id)!.hasChildren).toBe(true);
  });

  it('case 2 — DRILL a root-member story returns its NORMAL (unscoped) children', async () => {
    const fx = await makeFixture();
    const sprintId = await createActiveSprint(fx);
    const t = await seedTree(fx, sprintId);

    const roadmap = await workItemsService.getProjectRoadmap(fx.projectId, t.storyA2.id, fx.ctx, {
      scope: 'sprint',
    });
    expect(roadmap.nodes.map((n) => n.id)).toEqual([t.a3.id]);
  });

  it('case 3 — PROGRESS on a root-member is the FULL subtree rollup', async () => {
    const fx = await makeFixture();
    const sprintId = await createActiveSprint(fx);
    const t = await seedTree(fx, sprintId);

    const roadmap = await workItemsService.getProjectRoadmap(fx.projectId, null, fx.ctx, {
      scope: 'sprint',
    });
    // Story A2's subtree { a3 } (done) → 1 / 1; a1 is a leaf → null.
    expect(roadmap.nodes.find((n) => n.id === t.storyA2.id)!.progress).toEqual({
      done: 1,
      total: 1,
    });
    expect(roadmap.nodes.find((n) => n.id === t.a1.id)!.progress).toBeNull();
  });

  it('exercises within-level is_blocked_by edges across the root members', async () => {
    const fx = await makeFixture();
    const sprintId = await createActiveSprint(fx);
    const t = await seedTree(fx, sprintId);

    const roadmap = await workItemsService.getProjectRoadmap(fx.projectId, null, fx.ctx, {
      scope: 'sprint',
    });
    expect(roadmap.edges).toEqual([{ blockedId: t.a1.id, blockerId: t.storyA2.id }]);
  });

  it('off-level blockers carry isDone + inActiveSprint so the client can tell a sprint-validity problem from a satisfied dep (MOTIR-1379)', async () => {
    const fx = await makeFixture();
    const sprintId = await createActiveSprint(fx);
    // A member story (a root member) blocked by THREE off-level items: an
    // out-of-sprint OPEN dep (the sprint-validity PROBLEM), an out-of-sprint DONE
    // dep (satisfied), and an IN-sprint dep that sits on another branch (satisfied).
    const member = await createWorkItem(fx, { kind: 'story', title: 'Billing' });
    await setSprint(member.id, sprintId);
    const openExternal = await createWorkItem(fx, { kind: 'story', title: 'Open external' });
    const doneExternal = await createWorkItem(fx, { kind: 'story', title: 'Done external' });
    await setStatus(doneExternal.id, 'done');
    // An in-sprint blocker nested under a different member story, so it is in the
    // sprint but OFF the root level.
    const otherMember = await createWorkItem(fx, { kind: 'story', title: 'Other member' });
    await setSprint(otherMember.id, sprintId);
    const inSprintDeep = await createWorkItem(fx, {
      kind: 'subtask',
      title: 'In-sprint deep',
      parentId: otherMember.id,
    });
    await setSprint(inSprintDeep.id, sprintId);
    await link(fx, member.id, openExternal.id);
    await link(fx, member.id, doneExternal.id);
    await link(fx, member.id, inSprintDeep.id);

    const roadmap = await workItemsService.getProjectRoadmap(fx.projectId, null, fx.ctx, {
      scope: 'sprint',
    });
    const byId = new Map(roadmap.offLevelBlockers.map((b) => [b.id, b]));
    // The open external dep — NOT done, NOT in sprint → the flagged problem.
    expect(byId.get(openExternal.id)).toMatchObject({ isDone: false, inActiveSprint: false });
    // The done dep — satisfied.
    expect(byId.get(doneExternal.id)).toMatchObject({ isDone: true, inActiveSprint: false });
    // The in-sprint (deeper) dep — in the sprint, so not an out-of-sprint problem.
    expect(byId.get(inSprintDeep.id)).toMatchObject({ isDone: false, inActiveSprint: true });
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

    await expect(
      workItemsService.getProjectRoadmap(fx.projectId, null, other.ctx, { scope: 'sprint' }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});
