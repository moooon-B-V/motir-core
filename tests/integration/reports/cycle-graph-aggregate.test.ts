import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { sprintsService } from '@/lib/services/sprintsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { makeWorkItemFixture, createTestWorkItem } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';
import type { Prisma } from '@prisma/client';

// Story 8.14 · Subtask 8.14.3 — workItemRevisionRepository.aggregateSprintCycleByDay.
// Real Postgres (no mocks). Drives the per-day scope / completed / started deltas
// off a SEEDED 1.4.6 revision trail at known dates and asserts the card's
// scenarios: a re-estimate-after-start MOVES live scope (the MOTIR-1288 class), a
// scope add / remove, a DONE-before-join item still counts toward scope (the
// no-done-gate difference from the burndown), and the started-boundary
// transitions. One grouped query (finding #57); `workspaceId`-gated (finding #26).

/** A UTC-midnight `Date` for the given calendar day. */
function utcDay(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

/** Insert one revision row at a known instant (the test-direct seed of the 1.4.6
 *  trail — tests may reach the repo/db edge for setup, per CLAUDE.md). */
async function addRevision(
  workItemId: string,
  changedById: string,
  changedAt: Date,
  diff: Prisma.InputJsonValue,
): Promise<void> {
  await db.workItemRevision.create({
    data: { workItemId, changedById, changeKind: 'updated', changedAt, diff },
  });
}

/** Put an issue into the sprint with a current status + points snapshot. */
async function place(
  id: string,
  sprintId: string | null,
  status: string,
  storyPoints: number | null,
): Promise<void> {
  await db.workItem.update({ where: { id }, data: { sprintId, status, storyPoints } });
}

const WINDOW = { start: utcDay(2026, 6, 1), end: utcDay(2026, 6, 10) };
const byDay = (
  rows: Array<{ day: string; scopeDelta: number; completedDelta: number; startedDelta: number }>,
) => {
  const m = new Map(rows.map((r) => [r.day, r]));
  return (day: string) => m.get(day) ?? { day, scopeDelta: 0, completedDelta: 0, startedDelta: 0 };
};

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('aggregateSprintCycleByDay', () => {
  it('emits scope / completed / started deltas — incl. a re-estimate, a scope add/remove, and a done-before-join item', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'S1' }, fx.ctx);
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A (start+complete)' });
    const b = await createTestWorkItem(fx, { kind: 'task', title: 'B (re-estimate)' });
    const c = await createTestWorkItem(fx, { kind: 'task', title: 'C (scope add)' });
    const d = await createTestWorkItem(fx, { kind: 'task', title: 'D (scope remove)' });
    const e = await createTestWorkItem(fx, { kind: 'task', title: 'E (done before join)' });

    // Present state.
    await place(a.id, sprint.id, 'done', 3);
    await place(b.id, sprint.id, 'todo', 5); // points after the re-estimate
    await place(c.id, sprint.id, 'todo', 4);
    await place(d.id, null, 'todo', 8); // removed from the sprint
    await place(e.id, sprint.id, 'done', 5); // already done when it joined

    // The trail.
    await addRevision(a.id, fx.ownerId, utcDay(2026, 6, 2), {
      status: { from: 'todo', to: 'in_progress' }, // A starts → started +3
    });
    await addRevision(b.id, fx.ownerId, utcDay(2026, 6, 3), {
      storyPoints: { from: 2, to: 5 }, // re-estimate +3 to live scope
    });
    await addRevision(a.id, fx.ownerId, utcDay(2026, 6, 4), {
      status: { from: 'in_progress', to: 'done' }, // A completes → completed +3
    });
    await addRevision(c.id, fx.ownerId, utcDay(2026, 6, 5), {
      sprintId: { from: null, to: sprint.id }, // scope add +4
    });
    await addRevision(d.id, fx.ownerId, utcDay(2026, 6, 6), {
      sprintId: { from: sprint.id, to: null }, // scope remove −8
    });
    await addRevision(e.id, fx.ownerId, utcDay(2026, 6, 7), {
      sprintId: { from: null, to: sprint.id }, // done item joins → scope +5 (NO done-gate)
    });

    const rows = await workItemRevisionRepository.aggregateSprintCycleByDay(
      sprint.id,
      fx.workspaceId,
      WINDOW,
      false,
    );
    const at = byDay(rows);

    // Jun 2 — A todo→in_progress: started +3, completed 0, scope 0.
    expect(at('2026-06-02')).toMatchObject({ startedDelta: 3, completedDelta: 0, scopeDelta: 0 });
    // Jun 3 — B re-estimate 2→5: scope +3 (live), no status move.
    expect(at('2026-06-03')).toMatchObject({ scopeDelta: 3, completedDelta: 0, startedDelta: 0 });
    // Jun 4 — A in_progress→done: completed +3; started unchanged (stays non-todo).
    expect(at('2026-06-04')).toMatchObject({ completedDelta: 3, startedDelta: 0, scopeDelta: 0 });
    // Jun 5 — C added: scope +4.
    expect(at('2026-06-05')).toMatchObject({ scopeDelta: 4 });
    // Jun 6 — D removed: scope −8 (counted at D's current points).
    expect(at('2026-06-06')).toMatchObject({ scopeDelta: -8 });
    // Jun 7 — E (already done) joins: scope +5, NOT 0 — scope counts done items,
    // unlike the burndown's remaining line (the no-done-gate difference).
    expect(at('2026-06-07')).toMatchObject({ scopeDelta: 5, completedDelta: 0 });
  });

  it('count mode: a re-estimate is a no-op; add/remove are ±1', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'S2' }, fx.ctx);
    const b = await createTestWorkItem(fx, { kind: 'task', title: 'B (re-estimate)' });
    const c = await createTestWorkItem(fx, { kind: 'task', title: 'C (add)' });
    await place(b.id, sprint.id, 'todo', 5);
    await place(c.id, sprint.id, 'todo', 4);
    await addRevision(b.id, fx.ownerId, utcDay(2026, 6, 3), { storyPoints: { from: 2, to: 5 } });
    await addRevision(c.id, fx.ownerId, utcDay(2026, 6, 5), {
      sprintId: { from: null, to: sprint.id },
    });

    const rows = await workItemRevisionRepository.aggregateSprintCycleByDay(
      sprint.id,
      fx.workspaceId,
      WINDOW,
      true, // count mode
    );
    const at = byDay(rows);
    expect(at('2026-06-03').scopeDelta).toBe(0); // re-estimate doesn't change the issue count
    expect(at('2026-06-05').scopeDelta).toBe(1); // an add is +1 issue
  });

  it('started decrements when an item returns to the todo category', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'S3' }, fx.ctx);
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A' });
    await place(a.id, sprint.id, 'todo', 3);
    await addRevision(a.id, fx.ownerId, utcDay(2026, 6, 2), {
      status: { from: 'todo', to: 'in_progress' }, // +3 started
    });
    await addRevision(a.id, fx.ownerId, utcDay(2026, 6, 4), {
      status: { from: 'in_progress', to: 'todo' }, // back to todo → −3 started
    });
    const rows = await workItemRevisionRepository.aggregateSprintCycleByDay(
      sprint.id,
      fx.workspaceId,
      WINDOW,
      false,
    );
    const at = byDay(rows);
    expect(at('2026-06-02').startedDelta).toBe(3);
    expect(at('2026-06-04').startedDelta).toBe(-3);
  });

  it('is workspace-gated — a different workspace sees no deltas (finding #26)', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'S4' }, fx.ctx);
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A' });
    await place(a.id, sprint.id, 'done', 3);
    await addRevision(a.id, fx.ownerId, utcDay(2026, 6, 2), {
      status: { from: 'todo', to: 'done' },
    });
    const rows = await workItemRevisionRepository.aggregateSprintCycleByDay(
      sprint.id,
      other.workspaceId, // wrong tenant
      WINDOW,
      false,
    );
    expect(rows).toHaveLength(0);
  });
});

describe('workItemRepository.sumStartedForSprint', () => {
  it('sums the non-todo (in-progress + done) work in each statistic; the todo item is excluded', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Started' }, fx.ctx);
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A done' });
    const b = await createTestWorkItem(fx, { kind: 'task', title: 'B in progress' });
    const c = await createTestWorkItem(fx, { kind: 'task', title: 'C todo (excluded)' });
    // points + minutes set so each statistic resolves to a number.
    await db.workItem.update({
      where: { id: a.id },
      data: { sprintId: sprint.id, status: 'done', storyPoints: 5, estimateMinutes: 50 },
    });
    await db.workItem.update({
      where: { id: b.id },
      data: { sprintId: sprint.id, status: 'in_progress', storyPoints: 8, estimateMinutes: 80 },
    });
    await db.workItem.update({
      where: { id: c.id },
      data: { sprintId: sprint.id, status: 'todo', storyPoints: 3, estimateMinutes: 30 },
    });

    // story_points: A + B (non-todo) = 13; C (todo) excluded.
    expect(
      await workItemRepository.sumStartedForSprint(sprint.id, fx.workspaceId, 'story_points'),
    ).toBe(13);
    // issue_count: 2 started items.
    expect(
      await workItemRepository.sumStartedForSprint(sprint.id, fx.workspaceId, 'issue_count'),
    ).toBe(2);
    // time_estimate: A + B minutes = 130 (the third statistic branch).
    expect(
      await workItemRepository.sumStartedForSprint(sprint.id, fx.workspaceId, 'time_estimate'),
    ).toBe(130);
  });

  it('is 0 for an empty / all-todo sprint and workspace-gated (never NaN)', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Empty' }, fx.ctx);
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A todo' });
    await db.workItem.update({
      where: { id: a.id },
      data: { sprintId: sprint.id, status: 'todo', storyPoints: 5 },
    });
    expect(
      await workItemRepository.sumStartedForSprint(sprint.id, fx.workspaceId, 'story_points'),
    ).toBe(0);
    // wrong tenant sees nothing.
    expect(
      await workItemRepository.sumStartedForSprint(sprint.id, other.workspaceId, 'story_points'),
    ).toBe(0);
  });
});
