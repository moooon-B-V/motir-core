import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { sprintsService } from '@/lib/services/sprintsService';
import { estimationService } from '@/lib/services/estimationService';
import { reportsService } from '@/lib/services/reportsService';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { makeWorkItemFixture, createTestWorkItem } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';
import type { Prisma } from '@prisma/client';

// Story 8.14 · Subtask 8.14.7 — the cycle-graph INTEGRATION SEAM (real Postgres).
// The integration-seam rule: read 8.14.3's per-day aggregate (the WRITER,
// `aggregateSprintCycleByDay`) BACK through 8.14.4's `getSprintCycleGraph`
// `CycleGraphDto` (the CONSUMER) and assert they line up — catching the KEY DRIFT
// the units mask (a scope delta mislabelled as completed would still type-check
// and still be a plain number). Replaces the obsolete burndown integration test;
// covers the scenarios that broke the old burndown — `committedPoints` null /
// items estimated after start (re-estimate moves scope), scope add/remove, a
// done-before-join item, reconciliation to `rollupForSprint`, and scope-creep.

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

describe('cycle-graph seam — repo aggregate read back through the service DTO', () => {
  it('the cumulated DTO series equal the start baselines + the repo deltas, day by day (no key drift)', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Seam' }, fx.ctx);
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A' });
    const b = await createTestWorkItem(fx, { kind: 'task', title: 'B' });
    const c = await createTestWorkItem(fx, { kind: 'task', title: 'C (re-estimate)' });
    const d = await createTestWorkItem(fx, { kind: 'task', title: 'D (scope add)' });

    // Present: A done(5), B in progress(8), C todo(5, re-estimated up), D todo(4,
    // added mid-sprint). committedPoints NULL — the MOTIR-1288 no-snapshot case.
    await place(a.id, sprint.id, 'done', 5);
    await place(b.id, sprint.id, 'in_progress', 8);
    await place(c.id, sprint.id, 'todo', 5);
    await place(d.id, sprint.id, 'todo', 4);
    await stampSprint(sprint.id, {
      state: 'complete',
      startDate: utcDay(2026, 6, 1),
      endDate: utcDay(2026, 6, 12),
      completedAt: utcDay(2026, 6, 12),
      committedPoints: null,
      committedIssueCount: null,
    });
    await addRevision(a.id, fx.ownerId, utcDay(2026, 6, 2), {
      status: { from: 'todo', to: 'in_progress' }, // started +5
    });
    await addRevision(a.id, fx.ownerId, utcDay(2026, 6, 3), {
      status: { from: 'in_progress', to: 'done' }, // completed +5
    });
    await addRevision(b.id, fx.ownerId, utcDay(2026, 6, 4), {
      status: { from: 'todo', to: 'in_progress' }, // started +8
    });
    await addRevision(c.id, fx.ownerId, utcDay(2026, 6, 5), {
      storyPoints: { from: 2, to: 5 }, // scope +3
    });
    await addRevision(d.id, fx.ownerId, utcDay(2026, 6, 6), {
      sprintId: { from: null, to: sprint.id }, // scope +4
    });

    // The WRITER (8.14.3) and the CONSUMER (8.14.4) read the SAME window.
    const window = { start: utcDay(2026, 6, 1), end: utcDay(2026, 6, 12) };
    const rows = await workItemRevisionRepository.aggregateSprintCycleByDay(
      sprint.id,
      fx.workspaceId,
      window,
      false,
    );
    const cycle = await reportsService.getSprintCycleGraph(sprint.id, fx.ctx);

    // Reconstruct what the DTO's cumulated series SHOULD be from the repo rows +
    // the DTO's reconstructed baselines — the seam: writer deltas → consumer DTO.
    const delta = new Map(rows.map((r) => [r.day, r]));
    const sum = (k: 'scopeDelta' | 'completedDelta' | 'startedDelta') =>
      rows.reduce((acc, r) => acc + r[k], 0);
    // The DTO exposes committedAtStart; derive the other two baselines the same way
    // the service does (current − Σ delta) to cross-check the whole cumulation.
    const completedAtStart = 5 - sum('completedDelta'); // currentCompleted 5
    const startedAtStart = 13 - sum('startedDelta'); // currentStarted 13 (A,B)
    expect(cycle.committedAtStart).toBe(15); // 22 − 7

    let scope = cycle.committedAtStart;
    let completed = completedAtStart;
    let started = startedAtStart;
    for (const day of cycle.days) {
      const d2 = delta.get(day.date);
      scope += d2?.scopeDelta ?? 0;
      completed += d2?.completedDelta ?? 0;
      started += d2?.startedDelta ?? 0;
      if (day.scope === null) continue; // future day (none here — complete sprint)
      // The DTO's drawn series EXACTLY track the repo deltas cumulated off the
      // baselines — proving scope/completed/started keys are wired straight through.
      expect(day.scope).toBe(scope);
      expect(day.completed).toBe(completed);
      expect(day.started).toBe(started);
    }
  });

  it('each event kind lands in the RIGHT series (the key-drift guard)', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Keys' }, fx.ctx);
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A' });
    const c = await createTestWorkItem(fx, { kind: 'task', title: 'C' });
    await place(a.id, sprint.id, 'done', 5);
    await place(c.id, sprint.id, 'todo', 5);
    await stampSprint(sprint.id, {
      state: 'complete',
      startDate: utcDay(2026, 6, 1),
      endDate: utcDay(2026, 6, 12),
      completedAt: utcDay(2026, 6, 12),
      committedPoints: null,
      committedIssueCount: null,
    });
    await addRevision(a.id, fx.ownerId, utcDay(2026, 6, 2), {
      status: { from: 'todo', to: 'in_progress' },
    });
    await addRevision(a.id, fx.ownerId, utcDay(2026, 6, 3), {
      status: { from: 'in_progress', to: 'done' },
    });
    await addRevision(c.id, fx.ownerId, utcDay(2026, 6, 5), { storyPoints: { from: 2, to: 5 } });

    const cycle = await reportsService.getSprintCycleGraph(sprint.id, fx.ctx);
    const at = (date: string) => cycle.days.find((dd) => dd.date === date)!;

    // A's START (06-02) bumps STARTED only (not scope/completed).
    expect(at('2026-06-02').started! - at('2026-06-01').started!).toBe(5);
    expect(at('2026-06-02').completed).toBe(at('2026-06-01').completed);
    expect(at('2026-06-02').scope).toBe(at('2026-06-01').scope);
    // A's COMPLETION (06-03) bumps COMPLETED only.
    expect(at('2026-06-03').completed! - at('2026-06-02').completed!).toBe(5);
    expect(at('2026-06-03').started).toBe(at('2026-06-02').started);
    // C's RE-ESTIMATE (06-05) bumps SCOPE only — the live-scope move (MOTIR-1288).
    expect(at('2026-06-05').scope! - at('2026-06-04').scope!).toBe(3);
    expect(at('2026-06-05').completed).toBe(at('2026-06-04').completed);
  });

  it('reconciles to rollupForSprint and computes scope-creep (the MOTIR-1285/1288 scenario)', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Reconcile' }, fx.ctx);
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A' });
    const d = await createTestWorkItem(fx, { kind: 'task', title: 'D' });
    await place(a.id, sprint.id, 'done', 10);
    await place(d.id, sprint.id, 'todo', 6);
    await stampSprint(sprint.id, {
      state: 'complete',
      startDate: utcDay(2026, 6, 1),
      endDate: utcDay(2026, 6, 12),
      completedAt: utcDay(2026, 6, 12),
      committedPoints: null, // no snapshot
      committedIssueCount: null,
    });
    await addRevision(a.id, fx.ownerId, utcDay(2026, 6, 2), {
      status: { from: 'todo', to: 'done' },
    });
    await addRevision(d.id, fx.ownerId, utcDay(2026, 6, 4), {
      sprintId: { from: null, to: sprint.id }, // +6 scope after start
    });

    const rollup = await estimationService.rollupForSprint(sprint.id, fx.ctx);
    const cycle = await reportsService.getSprintCycleGraph(sprint.id, fx.ctx);
    const drawn = cycle.days.filter((dd) => dd.scope !== null);
    const last = drawn[drawn.length - 1]!;
    expect(last.scope).toBe(rollup.committed); // 16
    expect(last.completed).toBe(rollup.completed); // 10
    expect(cycle.committedAtStart).toBe(10); // 16 − 6
    expect(cycle.scopeCreepPct).toBeCloseTo(6 / 10, 4); // 0.6
  });
});
