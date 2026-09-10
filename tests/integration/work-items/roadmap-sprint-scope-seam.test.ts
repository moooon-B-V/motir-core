import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { adminDb } from '../../helpers/adminDb';
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
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_revision", "work_item_link", "work_item", "sprint" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function createActiveSprint(fx: WorkItemFixture, name = 'Sprint 1'): Promise<string> {
  const sprint = await adminDb.sprint.create({
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
  await adminDb.workItem.update({ where: { id }, data: { sprintId } });
}
async function setStatus(id: string, status: string): Promise<void> {
  await adminDb.workItem.update({ where: { id }, data: { status } });
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
      verified: 0,
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

  it('a CANCELLED off-level blocker is TERMINAL → isDone:true (not flagged "not in sprint"), matching validate_sprint (MOTIR-1561)', async () => {
    const fx = await makeFixture();
    const sprintId = await createActiveSprint(fx);
    // A member story blocked by an off-level dep that is CANCELLED and outside the
    // sprint. Cancelled is a `done`-CATEGORY (terminal) status, so the dependency
    // can never gate — the roadmap must treat it as satisfied (isDone:true) exactly
    // as validate_sprint does, NOT as the progress-meter "completed" set (which
    // drops cancelled) once did, which wrongly flagged it a sprint-validity problem.
    const member = await createWorkItem(fx, { kind: 'story', title: 'Billing' });
    await setSprint(member.id, sprintId);
    const cancelledExternal = await createWorkItem(fx, {
      kind: 'story',
      title: 'Cancelled external',
    });
    await setStatus(cancelledExternal.id, 'cancelled');
    await link(fx, member.id, cancelledExternal.id);

    const roadmap = await workItemsService.getProjectRoadmap(fx.projectId, null, fx.ctx, {
      scope: 'sprint',
    });
    const stub = roadmap.offLevelBlockers.find((b) => b.id === cancelledExternal.id);
    // Satisfied like a `done` dep — the client won't draw the cross edge / tag.
    expect(stub).toMatchObject({ isDone: true, inActiveSprint: false });
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
    await adminDb.sprint.update({ where: { id: sprintId }, data: { state: 'complete' } });

    const roadmap = await workItemsService.getProjectRoadmap(fx.projectId, null, fx.ctx, {
      scope: 'sprint',
    });
    // `levelTotal` rides the same DTO (MOTIR-3490) — an empty level is `0 of 0`;
    // so does `levelMemberBlockers` (MOTIR-5043), empty for want of a read at all.
    expect(roadmap).toEqual({
      nodes: [],
      edges: [],
      offLevelBlockers: [],
      levelMemberBlockers: [],
      levelTotal: 0,
    });
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

// ── MOTIR-5043 · the sprint arm is NOT where the cap defect lives ─────────────
// The project arm treats every off-level blocker as the cross-story tangle, which
// is what a cap-dropped SIBLING is now kept out of. The sprint arm asks a different
// question — is this blocker done, or in the sprint? — and its answer about a
// sibling outside the sprint ("blocker not in sprint") is TRUE.
//
// It is also the arm where a parent comparison means nothing, and the ROOT level is
// where that bites: `findProjectTreeLevel` re-roots a sprint level at the topmost
// IN-SPRINT rows, so a level requested with `parentId: null` comes back holding rows
// with real parents — while a blocker that IS parentless matches that null exactly.
// The member test would then claim a parentless out-of-sprint blocker as a member of
// a level it is not on, and the sprint-validity signal about it would vanish. It
// needs no 200-row level to reproduce, which is why it is pinned here.
describe('sprint scope claims no level members (MOTIR-5043)', () => {
  it('a PARENTLESS out-of-sprint blocker stays off-level at the re-rooted root, keeping its signal', async () => {
    const fx = await makeFixture();
    const sprintId = await createActiveSprint(fx);
    const story = await createWorkItem(fx, { kind: 'story', title: 'Story S' });
    const inSprint = await createWorkItem(fx, {
      kind: 'subtask',
      title: 's1 (in sprint)',
      parentId: story.id,
    });
    // A root-level defect nobody put in the sprint — `parentId` null, exactly like
    // the null the root level is requested with.
    const outOfSprint = await createWorkItem(fx, { kind: 'bug', title: 'Parentless blocker' });
    await setSprint(inSprint.id, sprintId);
    await link(fx, inSprint.id, outOfSprint.id);

    const level = await workItemsService.getProjectRoadmap(fx.projectId, null, fx.ctx, {
      scope: 'sprint',
    });
    // The re-rooted level is the in-sprint subtask, whose own parent is the story.
    expect(level.nodes.map((n) => n.id)).toEqual([inSprint.id]);
    const stub = level.offLevelBlockers.find((b) => b.id === outOfSprint.id);
    expect(stub).toBeTruthy();
    expect(stub!.isDone).toBe(false);
    expect(stub!.inActiveSprint).toBe(false);
    // …and nothing was reclassified as a level member, so the canvas still draws
    // "blocker not in sprint" rather than silence.
    expect(level.levelMemberBlockers).toEqual([]);
  });
});
