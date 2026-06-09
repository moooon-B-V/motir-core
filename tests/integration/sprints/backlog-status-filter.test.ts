import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { backlogService } from '@/lib/services/backlogService';
import { sprintsService } from '@/lib/services/sprintsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';
import { truncateAuthTables } from '../../helpers/db';

// Backlog status-category exclusion (Subtask 4.2.3, folded read change): the
// backlog is the to-be-planned pile, so `getBacklog` excludes issues in a
// `done`-category status (the default workflow's `done` + `cancelled`) from BOTH
// the list and the "N issues" count — while keeping `todo` AND `in_progress`
// (mirror rung 1: Jira hides only the Done column from the backlog; in-progress
// unsprinted issues stay). Done issues inside a sprint are unaffected. Real
// Postgres, per CLAUDE.md.

async function backlog(fx: WorkItemFixture) {
  const page = await backlogService.getBacklog(fx.projectId, { limit: 100 }, fx.ctx);
  return { ids: page.items.map((i) => i.id), totalCount: page.totalCount };
}

/** Set an issue's status directly (a fixture mutation; the test env bypasses RLS). */
async function setStatus(id: string, status: string) {
  await db.workItem.update({ where: { id }, data: { status } });
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('getBacklog status-category exclusion', () => {
  it('keeps todo + in_progress and excludes done-category issues from the list and count', async () => {
    const fx = await makeWorkItemFixture();
    const a = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'a' },
      fx.ctx,
    );
    const b = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'b' },
      fx.ctx,
    );
    const c = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'c' },
      fx.ctx,
    );
    const d = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'd' },
      fx.ctx,
    );
    await setStatus(b.id, 'in_progress'); // kept (not done-category)
    await setStatus(c.id, 'done'); // excluded
    await setStatus(d.id, 'cancelled'); // excluded (also done-category)

    const { ids, totalCount } = await backlog(fx);
    expect(ids).toEqual([a.id, b.id]);
    expect(totalCount).toBe(2);
  });

  it('keeps a done issue that lives in a sprint (getSprintIssues is unaffected)', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ctx);
    const e = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'e' },
      fx.ctx,
    );
    await backlogService.assignToSprint(e.id, sprint.id, undefined, fx.ctx);
    await setStatus(e.id, 'done');

    // Gone from the backlog…
    expect((await backlog(fx)).ids).not.toContain(e.id);
    // …but still in the sprint (part of its scope).
    const sprintPage = await backlogService.getSprintIssues(sprint.id, {}, fx.ctx);
    expect(sprintPage.items.map((i) => i.id)).toEqual([e.id]);
    expect(sprintPage.totalCount).toBe(1);
  });
});
