import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { truncateAuthTables } from '../../helpers/db';
import {
  makeWorkItemFixture as makeFixture,
  createTestWorkItem as createWorkItem,
} from '../../fixtures';

// Integration tests for the per-epic/story PROGRESS ROLL-UP correctness (Subtask
// 7.20.7 / MOTIR-1014) — the done/total meters `workItemsService.getProjectRoadmap`
// hangs on each container node (built by 7.20.6 / MOTIR-1013 over
// `workItemRepository.countRoadmapProgress`). Real Postgres, no mocks (Yue's rule).
//
// DELIBERATELY DISTINCT from `project-roadmap.test.ts`, which already covers the
// PER-LEVEL READ (ordering, hasChildren, isDone-by-category, archived exclusion,
// empty level, tenant gate, blocked_by edges) AND the baseline roll-up cases the
// implementing card shipped with it (a container's subtree done/total, leaves →
// null, a cancelled-only descendant → 0/0, archived descendants excluded). This
// file does NOT re-cover any of those. It adds the rollup-correctness angles those
// tests leave open (notes.html #102 — a story-level test card adds only the
// DISTINCT roll-up coverage, never a re-run of the read units):
//   1. a FULL mixed-status spread (todo / in_progress / in_review / done / cancelled)
//      rolled up at BOTH the epic and the story level of a 3-level tree;
//   2. an all-done container rolling up to 100% (done === total);
//   3. done resolved by workflow CATEGORY — a CUSTOM `done`-category status counts
//      as done (not just the default `done` KEY), while `cancelled` (also a
//      `done`-category status) is excluded from BOTH done and total.

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_revision", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  // Cascades from workspace → project → workflow_status, so the per-test custom
  // status from the category case never leaks (mirrors project-roadmap.test.ts).
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

describe('workItemsService.getProjectRoadmap — progress roll-up correctness (MOTIR-1014)', () => {
  it('rolls up per-EPIC and per-STORY done/total across a FULL mixed-status 3-level tree', async () => {
    const fx = await makeFixture();
    // E (epic)
    //  ├─ S1 (story)  t1 done · t2 in_progress · t3 todo · t4 cancelled
    //  └─ S2 (story)  u1 done · u2 in_review   · u3 done
    const E = await createWorkItem(fx, { kind: 'epic', title: 'Epic E' });
    const S1 = await createWorkItem(fx, { kind: 'story', title: 'Story S1', parentId: E.id });
    const t1 = await createWorkItem(fx, { kind: 'subtask', title: 't1', parentId: S1.id });
    const t2 = await createWorkItem(fx, { kind: 'subtask', title: 't2', parentId: S1.id });
    const t3 = await createWorkItem(fx, { kind: 'subtask', title: 't3', parentId: S1.id });
    const t4 = await createWorkItem(fx, { kind: 'subtask', title: 't4', parentId: S1.id });
    const S2 = await createWorkItem(fx, { kind: 'story', title: 'Story S2', parentId: E.id });
    const u1 = await createWorkItem(fx, { kind: 'subtask', title: 'u1', parentId: S2.id });
    const u2 = await createWorkItem(fx, { kind: 'subtask', title: 'u2', parentId: S2.id });
    const u3 = await createWorkItem(fx, { kind: 'subtask', title: 'u3', parentId: S2.id });

    await setStatus(t1.id, 'done');
    await setStatus(t2.id, 'in_progress');
    await setStatus(t3.id, 'todo');
    await setStatus(t4.id, 'cancelled');
    await setStatus(u1.id, 'done');
    await setStatus(u2.id, 'in_review');
    await setStatus(u3.id, 'done');
    // S1, S2, E keep the default `todo` status (containers are not done themselves).

    // Epic level (roots): E's WHOLE subtree rolls up. Descendants (depth > 1) are
    // S1, S2 (stories, todo) + t1..t4 + u1..u3. total excludes the cancelled t4 →
    // 2 stories + 3 live S1 subtasks + 3 S2 subtasks = 8. done = done-category only
    // = t1, u1, u3 = 3 (in_progress / in_review / todo are not done; stories todo).
    const roots = await workItemsService.getProjectRoadmap(fx.projectId, null, fx.ctx);
    const e = roots.nodes.find((n) => n.id === E.id)!;
    expect(e.progress).toEqual({ done: 3, total: 8, verified: 0 });

    // Story level under E: each story rolls up only its OWN subtasks.
    const stories = await workItemsService.getProjectRoadmap(fx.projectId, E.id, fx.ctx);
    const byId = new Map(stories.nodes.map((n) => [n.id, n]));
    // S1: live t1,t2,t3 (t4 cancelled excluded) → total 3; done = t1 → 1.
    expect(byId.get(S1.id)!.progress).toEqual({ done: 1, total: 3, verified: 0 });
    // S2: u1,u2,u3 → total 3; done = u1,u3 → 2 (u2 in_review is not done).
    expect(byId.get(S2.id)!.progress).toEqual({ done: 2, total: 3, verified: 0 });
  });

  it('an all-done container rolls up to 100% (done === total)', async () => {
    const fx = await makeFixture();
    const S = await createWorkItem(fx, { kind: 'story', title: 'All-done story' });
    const d1 = await createWorkItem(fx, { kind: 'subtask', title: 'd1', parentId: S.id });
    const d2 = await createWorkItem(fx, { kind: 'subtask', title: 'd2', parentId: S.id });
    const d3 = await createWorkItem(fx, { kind: 'subtask', title: 'd3', parentId: S.id });
    await setStatus(d1.id, 'done');
    await setStatus(d2.id, 'done');
    await setStatus(d3.id, 'done');

    const roots = await workItemsService.getProjectRoadmap(fx.projectId, null, fx.ctx);
    const s = roots.nodes.find((n) => n.id === S.id)!;
    expect(s.progress).toEqual({ done: 3, total: 3, verified: 0 });
    expect(s.progress!.done).toBe(s.progress!.total); // 100%
  });

  it('resolves done by CATEGORY: a custom done-category status counts as done; cancelled does not', async () => {
    const fx = await makeFixture();
    // A custom `done`-category status (NOT the default `done` key). The roll-up's
    // done-key set is derived by CATEGORY (every `done`-category status except the
    // sealed `cancelled`), so this must count toward `done`.
    await db.workflowStatus.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        key: 'shipped',
        label: 'Shipped',
        category: 'done',
        position: 'z0',
        isInitial: false,
      },
    });

    const S = await createWorkItem(fx, { kind: 'story', title: 'Category story' });
    const a = await createWorkItem(fx, { kind: 'subtask', title: 'a', parentId: S.id });
    const b = await createWorkItem(fx, { kind: 'subtask', title: 'b', parentId: S.id });
    const c = await createWorkItem(fx, { kind: 'subtask', title: 'c', parentId: S.id });
    const d = await createWorkItem(fx, { kind: 'subtask', title: 'd', parentId: S.id });
    await setStatus(a.id, 'done'); // default done KEY
    await setStatus(b.id, 'shipped'); // CUSTOM done-category status
    await setStatus(c.id, 'cancelled'); // done-category but EXCLUDED from done AND total
    await setStatus(d.id, 'in_progress'); // counts toward total only

    const roots = await workItemsService.getProjectRoadmap(fx.projectId, null, fx.ctx);
    const s = roots.nodes.find((n) => n.id === S.id)!;
    // total excludes cancelled c → a, b, d = 3. done = a (done) + b (shipped) = 2.
    expect(s.progress).toEqual({ done: 2, total: 3, verified: 0 });
  });
});
