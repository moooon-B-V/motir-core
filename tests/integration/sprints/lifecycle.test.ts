import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { backlogService } from '@/lib/services/backlogService';
import { boardsService } from '@/lib/services/boardsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';

// Story-level lifecycle tests for Story 4.4 (the closing test Subtask 4.4.7).
//
// The per-verb integration suites (start-sprint / complete-sprint / sprint-report
// / data-model) each prove ONE transition in isolation. THESE tests prove the
// verbs COMPOSE into the real journey — the integration-level mirror of the
// `sprint-lifecycle.spec.ts` E2E — exercising two end-to-end paths the per-verb
// tests don't run as a single chain:
//   1. plan → start → mark done → complete (carry to backlog) → read the report;
//   2. plan → start → complete (carry into a PLANNED sprint) → the freed slot
//      lets that next sprint start and report on the carried-in work.
// Real Postgres, no mocks (the project convention). Run: `pnpm test`.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Move an issue into a done-category status (the default workflow seeds
 *  `done`/`cancelled` as `category = done`). */
async function markDone(itemId: string): Promise<void> {
  await db.workItem.update({ where: { id: itemId }, data: { status: 'done' } });
}

/** Give an issue a story-point estimate directly (the estimation write path is a
 *  sibling Story 4.3 concern; here we only need the column populated). */
async function setPoints(itemId: string, points: number): Promise<void> {
  await db.workItem.update({ where: { id: itemId }, data: { storyPoints: points } });
}

/** Create N issues committed to `sprintId`, returning their ids in order. */
async function seedSprintIssues(
  fx: WorkItemFixture,
  sprintId: string,
  count: number,
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const issue = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: `issue ${i}` },
      fx.ctx,
    );
    await backlogService.assignToSprint(issue.id, sprintId, undefined, fx.ctx);
    ids.push(issue.id);
  }
  return ids;
}

describe('sprint lifecycle — composed journey (4.4.7)', () => {
  it('plan → start → mark done → complete (backlog) → report composes end-to-end', async () => {
    const fx = await makeWorkItemFixture();

    // Plan: a sprint with three estimated issues (3 + 2 + 5 = 10 points).
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Sprint 1' }, fx.ctx);
    const [a, b, c] = await seedSprintIssues(fx, sprint.id, 3);
    await setPoints(a!, 3);
    await setPoints(b!, 2);
    await setPoints(c!, 5);

    // Start: active, baseline stamped, the scrum board opened (one, idempotent).
    const started = await sprintsService.startSprint(sprint.id, {}, fx.ctx);
    expect(started.state).toBe('active');
    expect(started.committedIssueCount).toBe(3);
    expect(started.committedPoints).toBe(10);
    const boards = await boardsService.listBoards(fx.projectId, fx.ctx);
    expect(boards.filter((board) => board.type === 'scrum')).toHaveLength(1);

    // One issue ships; complete carrying the rest back to the backlog.
    await markDone(a!);
    const completed = await sprintsService.completeSprint(
      sprint.id,
      { carryOverTo: 'backlog' },
      fx.ctx,
    );
    expect(completed.state).toBe('complete');
    expect(completed.completedAt).not.toBeNull();

    // Report: the immutable committed baseline (10) survives the carry-over; the
    // done work (a = 3) is the completed total; b + c are back in the backlog.
    const report = await sprintsService.getSprintReport(sprint.id, {}, fx.ctx);
    expect(report.state).toBe('complete');
    expect(report.points.committed).toBe(10);
    expect(report.points.completed).toBe(3);
    expect(report.completed.totalCount).toBe(1);
    expect(report.completed.items.map((i) => i.id)).toEqual([a]);
    expect(report.incomplete.totalCount).toBe(0); // the unfinished left the sprint
    expect((await db.workItem.findUnique({ where: { id: b! } }))!.sprintId).toBeNull();
    expect((await db.workItem.findUnique({ where: { id: c! } }))!.sprintId).toBeNull();
  });

  it('carry-over INTO a planned sprint frees the slot; that next sprint then starts and reports', async () => {
    const fx = await makeWorkItemFixture();

    // Two planned sprints in the project: the first runs, the second receives the
    // carry-over (the "roll unfinished work into the next sprint" path).
    const first = await sprintsService.createSprint(fx.projectId, { name: 'Sprint 1' }, fx.ctx);
    const next = await sprintsService.createSprint(fx.projectId, { name: 'Sprint 2' }, fx.ctx);
    const [a, b, c] = await seedSprintIssues(fx, first.id, 3);
    await markDone(a!);
    await sprintsService.startSprint(first.id, {}, fx.ctx);

    // Complete first, rolling the two unfinished issues into the planned next.
    await sprintsService.completeSprint(first.id, { carryOverTo: { sprintId: next.id } }, fx.ctx);
    expect((await db.workItem.findUnique({ where: { id: b! } }))!.sprintId).toBe(next.id);
    expect((await db.workItem.findUnique({ where: { id: c! } }))!.sprintId).toBe(next.id);
    expect((await db.workItem.findUnique({ where: { id: a! } }))!.sprintId).toBe(first.id);

    // The one-active slot is freed → the next sprint starts, its baseline = the
    // two carried-in issues, and its report reads them as the live incomplete set.
    const startedNext = await sprintsService.startSprint(next.id, {}, fx.ctx);
    expect(startedNext.state).toBe('active');
    expect(startedNext.committedIssueCount).toBe(2);

    const nextReport = await sprintsService.getSprintReport(next.id, {}, fx.ctx);
    expect(nextReport.state).toBe('active'); // a live preview before completion
    expect(nextReport.completed.totalCount).toBe(0);
    expect(nextReport.incomplete.totalCount).toBe(2);
    expect(nextReport.incomplete.items.map((i) => i.id).sort()).toEqual([b, c].sort());
  });
});
