import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { sprintsService } from '@/lib/services/sprintsService';
import { estimationService } from '@/lib/services/estimationService';
import { reportsService } from '@/lib/services/reportsService';
import { SprintNotFoundError, SprintNotStartedError } from '@/lib/sprints/errors';
import { makeWorkItemFixture, createTestWorkItem } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';
import type { Prisma } from '@prisma/client';

// Story 8.14 · Subtask 8.14.4 — reportsService.getSprintCycleGraph. Real Postgres
// (no mocks). Drives the full reportsService → repository → Prisma chain against a
// SEEDED 1.4.6 revision trail on a COMPLETED sprint (deterministic cutoff =
// `completedAt`), asserting the service-level contract: the cumulated series
// RECONCILE to `rollupForSprint` (current scope + completed match the header), the
// reconstructed `committedAtStart` + `scopeCreepPct`, the target over working
// days, the NO-`committedPoints`-snapshot rendering (the MOTIR-1285/1288 case),
// and the not-started + tenancy guards.

function utcDay(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

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

async function place(
  id: string,
  sprintId: string | null,
  status: string,
  storyPoints: number | null,
): Promise<void> {
  await db.workItem.update({ where: { id }, data: { sprintId, status, storyPoints } });
}

async function stampSprint(
  sprintId: string,
  fields: {
    state: 'active' | 'complete';
    startDate: Date;
    endDate: Date | null;
    completedAt: Date | null;
    committedPoints: number | null;
    committedIssueCount: number | null;
  },
): Promise<void> {
  await db.sprint.update({ where: { id: sprintId }, data: fields });
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('reportsService.getSprintCycleGraph — derivation', () => {
  it('reconciles the last drawn scope/completed to rollupForSprint and reconstructs committedAtStart + scope-creep — with NO committedPoints snapshot (MOTIR-1288)', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Cycle' }, fx.ctx);
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A' });
    const b = await createTestWorkItem(fx, { kind: 'task', title: 'B' });
    const c = await createTestWorkItem(fx, { kind: 'task', title: 'C' });
    const d = await createTestWorkItem(fx, { kind: 'task', title: 'D (scope-added)' });

    // Present: A,B done; C in progress; D added mid-sprint. committed = 5+8+3+4 = 20,
    // completed = 13, started (non-todo) = 16 (A,B,C). committedPoints is NULL — the
    // MOTIR-1288 no-snapshot case the cycle graph must render regardless.
    await place(a.id, sprint.id, 'done', 5);
    await place(b.id, sprint.id, 'done', 8);
    await place(c.id, sprint.id, 'in_progress', 3);
    await place(d.id, sprint.id, 'todo', 4);
    await stampSprint(sprint.id, {
      state: 'complete',
      startDate: utcDay(2026, 6, 1),
      endDate: utcDay(2026, 6, 12),
      completedAt: utcDay(2026, 6, 12),
      committedPoints: null,
      committedIssueCount: null,
    });
    // Trail: starts + completions in-window; D joins on 06-05 (scope +4).
    await addRevision(c.id, fx.ownerId, utcDay(2026, 6, 2), {
      status: { from: 'todo', to: 'in_progress' },
    });
    await addRevision(a.id, fx.ownerId, utcDay(2026, 6, 2), {
      status: { from: 'todo', to: 'in_progress' },
    });
    await addRevision(a.id, fx.ownerId, utcDay(2026, 6, 3), {
      status: { from: 'in_progress', to: 'done' },
    });
    await addRevision(b.id, fx.ownerId, utcDay(2026, 6, 3), {
      status: { from: 'todo', to: 'in_progress' },
    });
    await addRevision(b.id, fx.ownerId, utcDay(2026, 6, 4), {
      status: { from: 'in_progress', to: 'done' },
    });
    await addRevision(d.id, fx.ownerId, utcDay(2026, 6, 5), {
      sprintId: { from: null, to: sprint.id },
    });

    const rollup = await estimationService.rollupForSprint(sprint.id, fx.ctx);
    expect(rollup).toMatchObject({ committed: 20, completed: 13 });

    const cycle = await reportsService.getSprintCycleGraph(sprint.id, fx.ctx);
    expect(cycle.statistic).toBe('story_points');
    expect(cycle.state).toBe('complete');

    // committedAtStart reconstructed = currentScope − Σ scopeDelta = 20 − 4 = 16
    // (A+B+C at start), with no committedPoints snapshot to read.
    expect(cycle.committedAtStart).toBe(16);
    // scope-creep = Σ scopeDelta / committedAtStart = 4 / 16 = 0.25.
    expect(cycle.scopeCreepPct).toBeCloseTo(0.25, 4);

    // The last drawn day reconciles to the live roll-up — the header agreement.
    const drawn = cycle.days.filter((day) => day.scope !== null);
    const last = drawn[drawn.length - 1]!;
    expect(last.scope).toBe(rollup.committed); // 20
    expect(last.completed).toBe(rollup.completed); // 13
    // started ends at 16 (A,B,C), between completed (13) and scope (20).
    expect(last.started).toBe(16);

    // Target: starts at committedAtStart and reaches 0 on the last working day.
    expect(cycle.days[0]!.target).toBe(16);
    expect(Math.min(...cycle.days.map((day) => day.target))).toBe(0);
  });

  it('renders a sprint started EMPTY as flat 0 lines (issue-count fallback), never NaN', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Empty' }, fx.ctx);
    await stampSprint(sprint.id, {
      state: 'complete',
      startDate: utcDay(2026, 6, 1),
      endDate: utcDay(2026, 6, 5),
      completedAt: utcDay(2026, 6, 5),
      committedPoints: null,
      committedIssueCount: 0,
    });
    const cycle = await reportsService.getSprintCycleGraph(sprint.id, fx.ctx);
    expect(cycle.statistic).toBe('issue_count'); // no point work → degrade
    expect(cycle.committedAtStart).toBe(0);
    expect(cycle.scopeCreepPct).toBe(0);
    for (const day of cycle.days) {
      expect(Number.isNaN(day.target)).toBe(false);
      if (day.scope !== null) {
        expect(day.scope).toBe(0);
        expect(day.completed).toBe(0);
        expect(day.started).toBe(0);
      }
    }
  });

  it('keeps the target descending when items were assigned AFTER start (committedAtStart from the snapshot, not the trail)', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Late' }, fx.ctx);
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A' });
    const b = await createTestWorkItem(fx, { kind: 'task', title: 'B' });
    await place(a.id, sprint.id, 'todo', 5);
    await place(b.id, sprint.id, 'todo', 7);
    // The start-then-populate flow: a real committedPoints SNAPSHOT (12), but the
    // trail records BOTH items joining the sprint AFTER startDate — so the
    // reconstruction (currentScope − Σ scopeDelta) = 12 − 12 = 0. The target must
    // NOT collapse onto the x-axis: committedAtStart falls back to the snapshot.
    await stampSprint(sprint.id, {
      state: 'complete',
      startDate: utcDay(2026, 6, 1),
      endDate: utcDay(2026, 6, 12),
      completedAt: utcDay(2026, 6, 12),
      committedPoints: 12,
      committedIssueCount: 2,
    });
    await addRevision(a.id, fx.ownerId, utcDay(2026, 6, 3), {
      sprintId: { from: null, to: sprint.id },
    });
    await addRevision(b.id, fx.ownerId, utcDay(2026, 6, 4), {
      sprintId: { from: null, to: sprint.id },
    });

    const rollup = await estimationService.rollupForSprint(sprint.id, fx.ctx);
    const cycle = await reportsService.getSprintCycleGraph(sprint.id, fx.ctx);

    // committedAtStart is the SNAPSHOT (12), not the trail's spurious 0.
    expect(cycle.committedAtStart).toBe(12);
    // The target descends from 12 and reaches 0 — it does NOT lie on the x-axis.
    expect(cycle.days[0]!.target).toBe(12);
    expect(Math.min(...cycle.days.map((d) => d.target))).toBe(0);
    // The scope SERIES still reconciles to the live roll-up at the cutoff.
    const drawn = cycle.days.filter((d) => d.scope !== null);
    expect(drawn[drawn.length - 1]!.scope).toBe(rollup.committed); // 12
  });

  it('falls back to the live scope for committedAtStart when there is no snapshot and the reconstruction is 0', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'NoSnap' }, fx.ctx);
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A' });
    await place(a.id, sprint.id, 'todo', 8);
    await stampSprint(sprint.id, {
      state: 'complete',
      startDate: utcDay(2026, 6, 1),
      endDate: utcDay(2026, 6, 12),
      completedAt: utcDay(2026, 6, 12),
      committedPoints: null, // no snapshot (MOTIR-1288)
      committedIssueCount: null,
    });
    await addRevision(a.id, fx.ownerId, utcDay(2026, 6, 3), {
      sprintId: { from: null, to: sprint.id }, // joined after start → reconstruction 0
    });
    const cycle = await reportsService.getSprintCycleGraph(sprint.id, fx.ctx);
    expect(cycle.committedAtStart).toBe(8); // live scope, not 0
    expect(cycle.days[0]!.target).toBe(8);
    expect(Math.min(...cycle.days.map((d) => d.target))).toBe(0);
  });
});

describe('reportsService.getSprintCycleGraph — active sprint', () => {
  it('draws actuals to "today" with null future days; the target spans the whole window', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Live' }, fx.ctx);
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A' });
    const b = await createTestWorkItem(fx, { kind: 'task', title: 'B' });
    await place(a.id, sprint.id, 'done', 5);
    await place(b.id, sprint.id, 'in_progress', 3);
    // An ACTIVE window straddling now (start 4 days ago, end 4 days ahead), so
    // there ARE future days after the actual cutoff ("now").
    const DAY = 24 * 60 * 60 * 1000;
    const midnight = (ms: number) => {
      const d = new Date(ms);
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    };
    const start = midnight(Date.now() - 4 * DAY);
    await stampSprint(sprint.id, {
      state: 'active',
      startDate: start,
      endDate: midnight(Date.now() + 4 * DAY),
      completedAt: null,
      committedPoints: null,
      committedIssueCount: null,
    });
    await addRevision(a.id, fx.ownerId, midnight(Date.now() - 2 * DAY), {
      status: { from: 'todo', to: 'done' },
    });

    const rollup = await estimationService.rollupForSprint(sprint.id, fx.ctx);
    const cycle = await reportsService.getSprintCycleGraph(sprint.id, fx.ctx);
    expect(cycle.state).toBe('active');
    // The actual series stop at "today" (some days drawn, some null in the future);
    // the target is always a number across the whole window.
    const drawn = cycle.days.filter((d) => d.scope !== null);
    const future = cycle.days.filter((d) => d.scope === null);
    expect(drawn.length).toBeGreaterThan(0);
    expect(future.length).toBeGreaterThan(0); // future days exist (active sprint)
    for (const d of cycle.days) expect(typeof d.target).toBe('number');
    // The last drawn day reconciles to the live roll-up.
    expect(drawn[drawn.length - 1]!.scope).toBe(rollup.committed);
    expect(drawn[drawn.length - 1]!.completed).toBe(rollup.completed);
  });
});

describe('reportsService.getSprintCycleGraph — guards', () => {
  it('rejects a not-yet-started (planned) sprint with SprintNotStartedError', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Planned' }, fx.ctx);
    await expect(reportsService.getSprintCycleGraph(sprint.id, fx.ctx)).rejects.toBeInstanceOf(
      SprintNotStartedError,
    );
  });

  it('is workspace-gated — a cross-workspace sprint is an indistinguishable 404', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'S' }, fx.ctx);
    await stampSprint(sprint.id, {
      state: 'active',
      startDate: utcDay(2026, 6, 1),
      endDate: utcDay(2026, 6, 12),
      completedAt: null,
      committedPoints: null,
      committedIssueCount: null,
    });
    await expect(reportsService.getSprintCycleGraph(sprint.id, other.ctx)).rejects.toBeInstanceOf(
      SprintNotFoundError,
    );
  });
});
