import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { truncateAuthTables } from '../../helpers/db';
import {
  makeWorkItemFixture as makeFixture,
  createTestWorkItem as createWorkItem,
} from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures';

// Unit coverage for the SPRINT-SCOPED per-level roadmap read (MOTIR-1381). The
// sprint-scoped roadmap is rooted at the TOPMOST in-sprint items — a member story
// shows as a root; the in-sprint subtasks of a NON-member story show as roots while
// the story/epic above them is elided; epics (never members) are never roots. Below
// a shown root member the tree is the NORMAL, unscoped read. Real Postgres, no mocks
// (Yue's rule). The story-level SEAM test (`roadmap-sprint-scope-seam.test.ts`,
// MOTIR-1383) drives the assembled `getProjectRoadmap` DTO; this file targets the
// repo's root-member selection + the service's empty/parity branches (notes.html
// #102).

const SORT = { column: 'key', direction: 'asc' } as const;
const PAGE = { take: 200, offset: 0 };

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

/** Direct column poke — tests may reach the DB to set state (CLAUDE.md). */
async function setSprint(id: string, sprintId: string | null): Promise<void> {
  await db.workItem.update({ where: { id }, data: { sprintId } });
}
async function setStatus(id: string, status: string): Promise<void> {
  await db.workItem.update({ where: { id }, data: { status } });
}

/**
 * The shared tree (sprint members = a1, Story A2):
 *   Epic A
 *     ├─ Story A1  (NOT a member)  ─ a1 (IN sprint, done) · a2 (backlog)
 *     ├─ Story A2  (IN sprint)     ─ a3 (backlog, done)
 *     └─ Story A3  (backlog, no in-sprint descendant)
 *   Epic B
 *     └─ Story B1  (backlog) ─ b1 (backlog)   — wholly backlog
 * Topmost in-sprint members ("root members", no member ancestor): { a1, Story A2 }.
 * Neither Epic A (contains members but isn't one) nor Story A1 (parent of a1) shows.
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
  await setSprint(storyA2.id, sprintId);
  await setStatus(a1.id, 'done');
  await setStatus(a3.id, 'done');

  return { epicA, storyA1, a1, a2, storyA2, a3, storyA3, epicB, storyB1, b1 };
}

describe('findProjectTreeLevel — sprint scope (top in-sprint roots)', () => {
  it('ROOT level returns the TOPMOST members — a member story + the in-sprint subtask of a non-member story', async () => {
    const fx = await makeFixture();
    const sprintId = await createActiveSprint(fx);
    const t = await seedTree(fx, sprintId);

    const rows = await workItemRepository.findProjectTreeLevel(
      fx.projectId,
      fx.workspaceId,
      null,
      SORT,
      PAGE,
      sprintId,
    );
    // The roots are a1 (subtask under non-member Story A1) and Story A2 (a member).
    // Epic A, Story A1, Story A3, Epic B are all ABSENT (epics/ancestors not pulled in).
    expect(rows.map((r) => r.id).sort()).toEqual([t.a1.id, t.storyA2.id].sort());
    // a1 is a leaf → not drillable; Story A2 has a child → drillable (normal probe).
    expect(rows.find((r) => r.id === t.a1.id)!.hasChildren).toBe(false);
    expect(rows.find((r) => r.id === t.storyA2.id)!.hasChildren).toBe(true);
  });

  it('DRILL a root-member story returns its NORMAL (unscoped) children — even backlog ones', async () => {
    const fx = await makeFixture();
    const sprintId = await createActiveSprint(fx);
    const t = await seedTree(fx, sprintId);

    const rows = await workItemRepository.findProjectTreeLevel(
      fx.projectId,
      fx.workspaceId,
      t.storyA2.id,
      SORT,
      PAGE,
      sprintId,
    );
    // a3 is backlog but Story A2 is the committed unit, so its full subtree shows.
    expect(rows.map((r) => r.id)).toEqual([t.a3.id]);
  });

  it('a member story whose subtask is ALSO a member still shows the STORY as the root', async () => {
    const fx = await makeFixture();
    const sprintId = await createActiveSprint(fx);
    const t = await seedTree(fx, sprintId);
    // Make a3 (under the member Story A2) a member too — A2 is still the topmost.
    await setSprint(t.a3.id, sprintId);

    const rows = await workItemRepository.findProjectTreeLevel(
      fx.projectId,
      fx.workspaceId,
      null,
      SORT,
      PAGE,
      sprintId,
    );
    // Still { a1, Story A2 } — a3 has a member ancestor (A2), so it is NOT a root.
    expect(rows.map((r) => r.id).sort()).toEqual([t.a1.id, t.storyA2.id].sort());
  });

  it('scope ABSENT (sprintId null) returns the unchanged whole-project root level (both epics)', async () => {
    const fx = await makeFixture();
    const sprintId = await createActiveSprint(fx);
    const t = await seedTree(fx, sprintId);

    const rows = await workItemRepository.findProjectTreeLevel(
      fx.projectId,
      fx.workspaceId,
      null,
      SORT,
      PAGE,
      null,
    );
    expect(rows.map((r) => r.id).sort()).toEqual([t.epicA.id, t.epicB.id].sort());
  });
});

describe('countRoadmapProgress — full subtree rollup (unchanged by scope)', () => {
  it('rolls up a root-member story over its WHOLE subtree', async () => {
    const fx = await makeFixture();
    const sprintId = await createActiveSprint(fx);
    const t = await seedTree(fx, sprintId);

    // Story A2's subtree is { a3 } (done) → total 1, done 1 — the full subtree, not
    // a sprint-pruned slice.
    const rows = await workItemRepository.countRoadmapProgress(
      [t.storyA2.id],
      ['done'],
      'cancelled',
    );
    expect(rows).toEqual([{ rootId: t.storyA2.id, total: 1, done: 1 }]);
  });
});

describe('getProjectRoadmap — service-owned sprint-scope branches', () => {
  it('returns an EMPTY roadmap when there is NO active sprint (not an error)', async () => {
    const fx = await makeFixture();
    const epic = await createWorkItem(fx, { kind: 'epic', title: 'Epic' });
    await createWorkItem(fx, { kind: 'story', title: 'Story', parentId: epic.id });

    const roadmap = await workItemsService.getProjectRoadmap(fx.projectId, null, fx.ctx, {
      scope: 'sprint',
    });
    expect(roadmap).toEqual({ nodes: [], edges: [], offLevelBlockers: [] });
  });

  it('whole-project parity: scope omitted === scope:project (and both show the epics)', async () => {
    const fx = await makeFixture();
    const sprintId = await createActiveSprint(fx);
    await seedTree(fx, sprintId);

    const omitted = await workItemsService.getProjectRoadmap(fx.projectId, null, fx.ctx);
    const explicit = await workItemsService.getProjectRoadmap(fx.projectId, null, fx.ctx, {
      scope: 'project',
    });
    expect(explicit).toEqual(omitted);
    expect(omitted.nodes.map((n) => n.title).sort()).toEqual(['Epic A', 'Epic B']);
  });
});
