import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { reportsService } from '@/lib/services/reportsService';
import { makeWorkItemFixture, createTestWorkItem } from '../../fixtures';
import { createTestUser } from '../../fixtures/userFixtures';
import { truncateAuthTables } from '../../helpers/db';
import type { WorkItem } from '@prisma/client';

// Story 8.8 · Subtask 8.8.13 — reportsService.getWorkload. Real Postgres. A
// SNAPSHOT read (no revision trail): open (current status NOT in a
// done-category) non-archived work_item rows grouped by assignee, ranked by the
// measure, with the unassigned bucket last. The matrix asserts: the ranking +
// unassigned-last rule, the done-category + archive exclusions, the
// points-vs-count measure re-rank, and the empty scope.

async function setFields(
  id: string,
  data: { assigneeId?: string | null; storyPoints?: number | null; status?: string },
): Promise<void> {
  await db.workItem.update({ where: { id }, data });
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

async function expectOk(promise: ReturnType<typeof reportsService.getWorkload>) {
  const result = await promise;
  expect(result.state).toBe('ok');
  if (result.state !== 'ok') throw new Error('unreachable');
  return result.data;
}

describe('getWorkload — the ranked open-work matrix', () => {
  it('ranks assignees by open story points desc, unassigned last, excluding done + archived', async () => {
    const fx = await makeWorkItemFixture();
    const bo = await createTestUser({ name: 'Bo' });
    const odie = await createTestUser({ name: 'Odie' });

    const seed = async (
      title: string,
      assigneeId: string | null,
      points: number,
      status = 'todo',
    ): Promise<WorkItem> => {
      const item = await createTestWorkItem(fx, { kind: 'task', title });
      await setFields(item.id, { assigneeId, storyPoints: points, status });
      return item;
    };

    // Bo: 8 + 5 open = 13; Odie: 3 open; unassigned: 2 open.
    await seed('A', bo.id, 8);
    await seed('B', bo.id, 5);
    await seed('C', odie.id, 3);
    await seed('D', null, 2);
    // Excluded: a DONE item (done-category current status) and an ARCHIVED one.
    await seed('E', bo.id, 100, 'done');
    const archived = await seed('F', odie.id, 100);
    await db.workItem.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });

    const data = await expectOk(
      reportsService.getWorkload({ projectId: fx.projectId }, { measure: 'story_points' }, fx.ctx),
    );

    expect(data.assignees.map((a) => [a.name, a.points, a.count])).toEqual([
      ['Bo', 13, 2],
      ['Odie', 3, 1],
      [null, 2, 1], // the unassigned bucket — always last, name null
    ]);
    expect(data.assignees.at(-1)!.assigneeId).toBeNull();
    expect(data.totalPoints).toBe(18);
    expect(data.totalCount).toBe(4);
    expect(data.measure).toBe('story_points');
  });

  it('re-ranks by issue COUNT when measure=issue_count, unassigned still last', async () => {
    const fx = await makeWorkItemFixture();
    const heavy = await createTestUser({ name: 'Heavy' }); // few big items
    const many = await createTestUser({ name: 'Many' }); // many small items

    const seed = async (assigneeId: string | null, points: number) => {
      const item = await createTestWorkItem(fx, { kind: 'task', title: 'x' });
      await setFields(item.id, { assigneeId, storyPoints: points, status: 'todo' });
    };
    // Heavy: 1 item × 20 pts. Many: 3 items × 1 pt = 3 pts.
    await seed(heavy.id, 20);
    await seed(many.id, 1);
    await seed(many.id, 1);
    await seed(many.id, 1);

    const data = await expectOk(
      reportsService.getWorkload({ projectId: fx.projectId }, { measure: 'issue_count' }, fx.ctx),
    );
    // By COUNT, Many (3) outranks Heavy (1) — the opposite of the points order.
    expect(data.assignees.map((a) => [a.name, a.count])).toEqual([
      ['Many', 3],
      ['Heavy', 1],
    ]);
  });

  it('counts an unestimated open item as 0 points but still 1 to the count', async () => {
    const fx = await makeWorkItemFixture();
    const u = await createTestUser({ name: 'U' });
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'x' });
    await setFields(item.id, { assigneeId: u.id, storyPoints: null, status: 'todo' });

    const data = await expectOk(
      reportsService.getWorkload({ projectId: fx.projectId }, { measure: 'story_points' }, fx.ctx),
    );
    expect(data.assignees).toEqual([{ assigneeId: u.id, name: 'U', points: 0, count: 1 }]);
  });

  it('returns an empty ranking + zero totals when there is no open work', async () => {
    const fx = await makeWorkItemFixture();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'done' });
    await setFields(item.id, { status: 'done', storyPoints: 5 });

    const data = await expectOk(
      reportsService.getWorkload({ projectId: fx.projectId }, { measure: 'story_points' }, fx.ctx),
    );
    expect(data.assignees).toEqual([]);
    expect(data.totalPoints).toBe(0);
    expect(data.totalCount).toBe(0);
  });
});
