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

// Unit coverage for the SPRINT-SCOPED per-level roadmap read (MOTIR-1381) — the
// repository member-or-ancestor pruning + sprint-scoped progress, and the service
// decisions it owns (no-active-sprint → empty, whole-project parity). Real
// Postgres, no mocks (Yue's rule). The story-level SEAM test
// (`roadmap-sprint-scope-seam.test.ts`, MOTIR-1383) drives the assembled
// `getProjectRoadmap` DTO across a richer tree; this file targets the repo
// methods directly + the service's empty/parity branches, so the two don't
// overlap (notes.html #102).

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
 * The shared tree:
 *   Epic A
 *     ├─ Story A1   ─ a1 (IN sprint, done) · a2 (backlog)
 *     ├─ Story A2   (backlog, no in-sprint descendants)
 *     └─ Story A3   (IN sprint itself — membership at the STORY grain; no kids)
 *   Epic B
 *     └─ Story B1   ─ b1 (backlog) — Epic B has NO in-sprint descendant
 * Sprint members: a1, A3. So the member-or-ancestor set is
 *   { a1, A3, Story A1, Epic A }  (Epic B / Story A2 / Story B1 / a2 / b1 are OUT).
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

  return { epicA, storyA1, a1, a2, storyA2, storyA3, epicB, storyB1, b1 };
}

describe('findProjectTreeLevel — sprint scope (member-or-ancestor)', () => {
  it('ROOT level returns only ancestors of in-sprint items (Epic B is pruned)', async () => {
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
    expect(rows.map((r) => r.id).sort()).toEqual([t.epicA.id].sort());
    // Epic A still drillable under scope (its in-sprint branch survives).
    expect(rows.find((r) => r.id === t.epicA.id)!.hasChildren).toBe(true);
  });

  it('DRILL Epic A returns only member-or-ancestor children with scoped hasChildren', async () => {
    const fx = await makeFixture();
    const sprintId = await createActiveSprint(fx);
    const t = await seedTree(fx, sprintId);

    const rows = await workItemRepository.findProjectTreeLevel(
      fx.projectId,
      fx.workspaceId,
      t.epicA.id,
      SORT,
      PAGE,
      sprintId,
    );
    // Story A1 (ancestor of a1) + Story A3 (member); Story A2 (backlog) is absent.
    expect(rows.map((r) => r.id).sort()).toEqual([t.storyA1.id, t.storyA3.id].sort());
    // A1 has an in-sprint child (a1) → drillable; A3 is a leaf member → no children.
    expect(rows.find((r) => r.id === t.storyA1.id)!.hasChildren).toBe(true);
    expect(rows.find((r) => r.id === t.storyA3.id)!.hasChildren).toBe(false);
  });

  it('DRILL Story A1 returns only the in-sprint leaf (the backlog sibling is pruned)', async () => {
    const fx = await makeFixture();
    const sprintId = await createActiveSprint(fx);
    const t = await seedTree(fx, sprintId);

    const rows = await workItemRepository.findProjectTreeLevel(
      fx.projectId,
      fx.workspaceId,
      t.storyA1.id,
      SORT,
      PAGE,
      sprintId,
    );
    expect(rows.map((r) => r.id)).toEqual([t.a1.id]); // a2 (backlog) absent
  });

  it('scope ABSENT (sprintId null) returns the unchanged whole-project level', async () => {
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
    // Both epics present in the whole-project read.
    expect(rows.map((r) => r.id).sort()).toEqual([t.epicA.id, t.epicB.id].sort());
  });
});

describe('countRoadmapProgress — sprint scope (in-sprint descendants only)', () => {
  it('counts only in-sprint descendants for a container', async () => {
    const fx = await makeFixture();
    const sprintId = await createActiveSprint(fx);
    const t = await seedTree(fx, sprintId);

    // Epic A in-sprint descendants = a1 (done) + Story A3 (todo) → total 2, done 1.
    const scoped = await workItemRepository.countRoadmapProgress(
      [t.epicA.id],
      ['done'],
      'cancelled',
      sprintId,
    );
    expect(scoped).toEqual([{ rootId: t.epicA.id, total: 2, done: 1 }]);

    // Whole-project rollup over the SAME root counts every live descendant.
    const whole = await workItemRepository.countRoadmapProgress(
      [t.epicA.id],
      ['done'],
      'cancelled',
      null,
    );
    // Descendants: A1, A2, A3, a1, a2 = 5 live; done = a1 = 1.
    expect(whole).toEqual([{ rootId: t.epicA.id, total: 5, done: 1 }]);
  });
});

describe('getProjectRoadmap — service-owned sprint-scope branches', () => {
  it('returns an EMPTY roadmap when there is NO active sprint (not an error)', async () => {
    const fx = await makeFixture();
    // Seed a tree but DO NOT create an active sprint.
    const epic = await createWorkItem(fx, { kind: 'epic', title: 'Epic' });
    await createWorkItem(fx, { kind: 'story', title: 'Story', parentId: epic.id });

    const roadmap = await workItemsService.getProjectRoadmap(fx.projectId, null, fx.ctx, {
      scope: 'sprint',
    });
    expect(roadmap).toEqual({ nodes: [], edges: [], offLevelBlockers: [] });
  });

  it('whole-project parity: scope omitted === scope:project (and both ignore the sprint)', async () => {
    const fx = await makeFixture();
    const sprintId = await createActiveSprint(fx);
    await seedTree(fx, sprintId);

    const omitted = await workItemsService.getProjectRoadmap(fx.projectId, null, fx.ctx);
    const explicit = await workItemsService.getProjectRoadmap(fx.projectId, null, fx.ctx, {
      scope: 'project',
    });
    expect(explicit).toEqual(omitted);
    // Whole project shows BOTH epics (sprint scoping is not applied).
    expect(omitted.nodes.map((n) => n.title).sort()).toEqual(['Epic A', 'Epic B']);
  });
});
