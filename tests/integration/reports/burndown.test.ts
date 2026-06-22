import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { sprintsService } from '@/lib/services/sprintsService';
import { reportsService } from '@/lib/services/reportsService';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { SprintNotFoundError, SprintNotStartedError } from '@/lib/sprints/errors';
import { makeWorkItemFixture, createTestWorkItem } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';
import type { WorkspaceContext } from '@/lib/workspaces';
import type { Prisma } from '@prisma/client';

// Story 4.6 · Subtask 4.6.3 — reportsService.getBurndownSeries. Real Postgres
// (no mocks; only `getWorkspaceContext` is stubbed for the route smoke, per
// CLAUDE.md). The service-level tests drive the full reportsService → repository
// → Prisma chain. They reconstruct the actual line from a SEEDED 1.4.6 revision
// trail at known dates against a COMPLETED sprint (so the actual cutoff —
// `completedAt` — is deterministic, unlike a live sprint's "now"), and assert:
// the guideline, the stepped actual (drops on completion days, rises on
// scope-add days + reopens), the scope-change markers, the end-point ==
// `rollupForSprint().remaining` reconciliation, the bounded grouped-by-day
// aggregate, the degraded (unestimated / issue-count) + empty + single-day
// states, and the tenancy + not-started guards. The at-scale combined Scrum
// journey is Story 4.7's, not duplicated here.

const DAY_MS = 24 * 60 * 60 * 1000;

/** A UTC-midnight `Date` for the given calendar day. */
function utcDay(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

/** Insert one revision row at a known instant (the test-direct seed of the
 *  1.4.6 trail — tests may reach the repo/db edge for setup, per CLAUDE.md). */
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

/** Stamp a sprint's window + state + committed baseline directly (the
 *  deterministic equivalent of startSprint→completeSprint; startSprint itself is
 *  covered in start-sprint.test.ts). */
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

function byDate(days: Array<{ date: string; remaining: number | null; guideline: number }>) {
  return (date: string) => days.find((d) => d.date === date)!;
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('reportsService.getBurndownSeries — derivation', () => {
  it('builds the guideline + stepped actual from the committed baseline and the revision trail, with the end-point reconciling to rollupForSprint().remaining', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'S1' }, fx.ctx);
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A' });
    const b = await createTestWorkItem(fx, { kind: 'task', title: 'B' });
    const c = await createTestWorkItem(fx, { kind: 'task', title: 'C' });
    const d = await createTestWorkItem(fx, { kind: 'task', title: 'D (scope-added)' });

    // Present state: A,B,C committed at start; D added mid-sprint. A,B done.
    await place(a.id, sprint.id, 'done', 5);
    await place(b.id, sprint.id, 'done', 8);
    await place(c.id, sprint.id, 'todo', 3);
    await place(d.id, sprint.id, 'todo', 4);
    // Locked baseline = A+B+C at start (16 pts / 3 work items); D is NOT in it.
    await stampSprint(sprint.id, {
      state: 'complete',
      startDate: utcDay(2026, 6, 1),
      endDate: utcDay(2026, 6, 10),
      completedAt: utcDay(2026, 6, 10),
      committedPoints: 16,
      committedIssueCount: 3,
    });
    // The trail: A done 06-03, D added 06-05, B done 06-06.
    await addRevision(a.id, fx.ownerId, utcDay(2026, 6, 3), {
      status: { from: 'todo', to: 'done' },
    });
    await addRevision(d.id, fx.ownerId, utcDay(2026, 6, 5), {
      sprintId: { from: null, to: sprint.id },
    });
    await addRevision(b.id, fx.ownerId, utcDay(2026, 6, 6), {
      status: { from: 'todo', to: 'done' },
    });

    const series = await reportsService.getBurndownSeries(sprint.id, fx.ctx);
    const at = byDate(series.days);

    expect(series.statistic).toBe('story_points');
    expect(series.committed).toBe(16); // the LOCKED baseline (not the live total)
    expect(series.state).toBe('complete');
    expect(series.days).toHaveLength(10); // 06-01 … 06-10 inclusive — bounded by sprint length

    // Guideline: straight committed → 0 across the window.
    expect(series.days[0]!.guideline).toBe(16);
    expect(series.days[9]!.guideline).toBe(0);

    // Actual: drops on completion days, RISES on the scope-add day.
    expect(at('2026-06-02').remaining).toBe(16); // nothing burned yet
    expect(at('2026-06-03').remaining).toBe(11); // A (5) done
    expect(at('2026-06-04').remaining).toBe(11); // flat
    expect(at('2026-06-05').remaining).toBe(15); // D (+4) scope-added → rises
    expect(at('2026-06-06').remaining).toBe(7); // B (8) done

    // End-point reconciles with the 4.3.3 roll-up (current members A,B,C,D =
    // 20 pts, A+B done = 13 → remaining 7).
    expect(series.days[9]!.remaining).toBe(7);

    // Scope-change marker on the add day.
    expect(series.scopeChanges).toEqual([{ date: '2026-06-05', delta: 4 }]);
  });

  it('a reopened issue adds its points back (actual drops then rises)', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Reopen' }, fx.ctx);
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A' });
    await place(a.id, sprint.id, 'todo', 5); // currently NOT done (reopened)
    await stampSprint(sprint.id, {
      state: 'complete',
      startDate: utcDay(2026, 6, 1),
      endDate: utcDay(2026, 6, 5),
      completedAt: utcDay(2026, 6, 5),
      committedPoints: 5,
      committedIssueCount: 1,
    });
    await addRevision(a.id, fx.ownerId, utcDay(2026, 6, 3), {
      status: { from: 'todo', to: 'done' },
    });
    await addRevision(a.id, fx.ownerId, utcDay(2026, 6, 4), {
      status: { from: 'done', to: 'todo' },
    });

    const series = await reportsService.getBurndownSeries(sprint.id, fx.ctx);
    const at = byDate(series.days);
    expect(at('2026-06-03').remaining).toBe(0); // burned down
    expect(at('2026-06-04').remaining).toBe(5); // reopened → added back
    expect(series.days[series.days.length - 1]!.remaining).toBe(5); // == rollup.remaining
  });

  it('a scope REMOVAL drops the actual and is marked as a negative scope change', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Remove' }, fx.ctx);
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A (stays)' });
    const b = await createTestWorkItem(fx, { kind: 'task', title: 'B (removed)' });
    await place(a.id, sprint.id, 'todo', 5);
    await place(b.id, null, 'todo', 3); // removed from the sprint (sprintId null now)
    await stampSprint(sprint.id, {
      state: 'complete',
      startDate: utcDay(2026, 6, 1),
      endDate: utcDay(2026, 6, 10),
      completedAt: utcDay(2026, 6, 10),
      committedPoints: 8, // A+B at start
      committedIssueCount: 2,
    });
    await addRevision(b.id, fx.ownerId, utcDay(2026, 6, 4), {
      sprintId: { from: sprint.id, to: null },
    });

    const series = await reportsService.getBurndownSeries(sprint.id, fx.ctx);
    const at = byDate(series.days);
    expect(at('2026-06-03').remaining).toBe(8);
    expect(at('2026-06-04').remaining).toBe(5); // B (3) removed → drops
    expect(series.scopeChanges).toEqual([{ date: '2026-06-04', delta: -3 }]);
    expect(series.days[9]!.remaining).toBe(5); // only A remains, not done
  });

  it('draws the actual only to "today" for a live sprint (future days are null)', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Live' }, fx.ctx);
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A' });
    await place(a.id, sprint.id, 'done', 5);
    const now = new Date();
    const todayKey = now.toISOString().slice(0, 10);
    await stampSprint(sprint.id, {
      state: 'active',
      startDate: new Date(now.getTime() - 3 * DAY_MS),
      endDate: new Date(now.getTime() + 3 * DAY_MS), // ends in the future
      completedAt: null,
      committedPoints: 5,
      committedIssueCount: 1,
    });
    await addRevision(a.id, fx.ownerId, new Date(now.getTime() - DAY_MS), {
      status: { from: 'todo', to: 'done' },
    });

    const series = await reportsService.getBurndownSeries(sprint.id, fx.ctx);
    expect(series.state).toBe('active');
    const today = series.days.find((d) => d.date === todayKey);
    expect(today?.remaining).not.toBeNull(); // today is drawn
    const futureNulls = series.days.filter((d) => d.date > todayKey);
    expect(futureNulls.length).toBeGreaterThan(0);
    expect(futureNulls.every((d) => d.remaining === null)).toBe(true); // future not drawn
    // Last DRAWN point reconciles with the live roll-up (current: A done → 0).
    const lastDrawn = [...series.days].reverse().find((d) => d.remaining !== null)!;
    expect(lastDrawn.remaining).toBe(0);
  });
});

// MOTIR-1285 — a sprint entered with already-`done` items must keep those points
// OUT of the remaining line: a done issue contributes 0 to remaining regardless
// of WHEN/HOW it joined the sprint (the verified Linear behaviour; Jira literally
// mis-counts this as added scope — the bug being fixed). Remaining at any time =
// the NOT-done in-scope points at that time, so the drawn line never disagrees
// with the numeric `rollupForSprint().remaining`.
describe('reportsService.getBurndownSeries — already-done items stay out of remaining (MOTIR-1285)', () => {
  it('a DONE item added mid-sprint does NOT raise the line (no phantom scope-add)', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'AddDone' }, fx.ctx);
    const b = await createTestWorkItem(fx, { kind: 'task', title: 'B' });
    const c = await createTestWorkItem(fx, { kind: 'task', title: 'C' });
    const e = await createTestWorkItem(fx, { kind: 'task', title: 'E (done, added later)' });

    // Present state: B,C committed at start (both not-done at start); E is added
    // mid-sprint having ALREADY been completed BEFORE it joined.
    await place(b.id, sprint.id, 'done', 8);
    await place(c.id, sprint.id, 'todo', 3);
    await place(e.id, sprint.id, 'done', 10);
    // Locked baseline = B+C at start (11 pts / 2 items); E is NOT in it.
    await stampSprint(sprint.id, {
      state: 'complete',
      startDate: utcDay(2026, 6, 1),
      endDate: utcDay(2026, 6, 10),
      completedAt: utcDay(2026, 6, 10),
      committedPoints: 11,
      committedIssueCount: 2,
    });
    // E completed BEFORE the sprint started (05-28 — outside the window, so no
    // burn event lands inside it), then was added to the sprint on 06-05.
    await addRevision(e.id, fx.ownerId, utcDay(2026, 5, 28), {
      status: { from: 'todo', to: 'done' },
    });
    await addRevision(e.id, fx.ownerId, utcDay(2026, 6, 5), {
      sprintId: { from: null, to: sprint.id },
    });
    // B done 06-06 (a real in-sprint burn).
    await addRevision(b.id, fx.ownerId, utcDay(2026, 6, 6), {
      status: { from: 'todo', to: 'done' },
    });

    const series = await reportsService.getBurndownSeries(sprint.id, fx.ctx);
    const at = byDate(series.days);

    // The actual line starts at the NOT-done work at start (B+C = 11), NOT the
    // committed total, and is FLAT across the day E (done) is added.
    expect(at('2026-06-02').remaining).toBe(11);
    expect(at('2026-06-05').remaining).toBe(11); // E added but already done → no rise
    expect(at('2026-06-06').remaining).toBe(3); // B (8) done → real burn
    // Ends at the authoritative remaining (current not-done = C only = 3).
    expect(series.days[9]!.remaining).toBe(3);
    // A done item's add is NOT a remaining-scope change → no misleading marker.
    expect(series.scopeChanges).toEqual([]);
  });

  it('an item already DONE at sprint start is kept out of the baseline', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'DoneAtStart' }, fx.ctx);
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A (done at start)' });
    const b = await createTestWorkItem(fx, { kind: 'task', title: 'B' });
    const c = await createTestWorkItem(fx, { kind: 'task', title: 'C' });

    // A,B,C all in the sprint from the start; A was already done at start.
    await place(a.id, sprint.id, 'done', 5);
    await place(b.id, sprint.id, 'done', 8);
    await place(c.id, sprint.id, 'todo', 3);
    // Locked baseline = the start snapshot of ALL members (5+8+3 = 16) — A's done
    // points are IN the committed total but must NOT show in the remaining line.
    await stampSprint(sprint.id, {
      state: 'complete',
      startDate: utcDay(2026, 6, 1),
      endDate: utcDay(2026, 6, 10),
      completedAt: utcDay(2026, 6, 10),
      committedPoints: 16,
      committedIssueCount: 3,
    });
    // A completed BEFORE the sprint (no burn event inside the window); B done 06-06.
    await addRevision(a.id, fx.ownerId, utcDay(2026, 5, 28), {
      status: { from: 'todo', to: 'done' },
    });
    await addRevision(b.id, fx.ownerId, utcDay(2026, 6, 6), {
      status: { from: 'todo', to: 'done' },
    });

    const series = await reportsService.getBurndownSeries(sprint.id, fx.ctx);
    const at = byDate(series.days);

    // committed (the guideline + "Committed" annotation) stays the locked total.
    expect(series.committed).toBe(16);
    // The actual remaining line excludes A (done at start): starts at B+C = 11.
    expect(at('2026-06-02').remaining).toBe(11);
    expect(at('2026-06-06').remaining).toBe(3); // B (8) done → C (3) remains
    expect(series.days[9]!.remaining).toBe(3); // == rollup.remaining (only C not done)
  });

  it('reconciles the live-bug shape: done-at-start + done-added-mid + real burn all agree with the roll-up', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Combined' }, fx.ctx);
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A (done at start)' });
    const b = await createTestWorkItem(fx, { kind: 'task', title: 'B (burns in-sprint)' });
    const c = await createTestWorkItem(fx, { kind: 'task', title: 'C (stays open)' });
    const e = await createTestWorkItem(fx, { kind: 'task', title: 'E (done, added mid)' });

    await place(a.id, sprint.id, 'done', 20); // done at start
    await place(b.id, sprint.id, 'done', 30); // burns during sprint
    await place(c.id, sprint.id, 'todo', 19); // never done
    await place(e.id, sprint.id, 'done', 21); // added mid-sprint, already done
    // Start snapshot of members A,B,C = 20+30+19 = 69 (E joins later).
    await stampSprint(sprint.id, {
      state: 'complete',
      startDate: utcDay(2026, 6, 1),
      endDate: utcDay(2026, 6, 10),
      completedAt: utcDay(2026, 6, 10),
      committedPoints: 69,
      committedIssueCount: 3,
    });
    await addRevision(a.id, fx.ownerId, utcDay(2026, 5, 20), {
      status: { from: 'todo', to: 'done' },
    }); // A done before start
    await addRevision(e.id, fx.ownerId, utcDay(2026, 5, 25), {
      status: { from: 'todo', to: 'done' },
    }); // E done before joining
    await addRevision(e.id, fx.ownerId, utcDay(2026, 6, 4), {
      sprintId: { from: null, to: sprint.id },
    }); // E joins (already done)
    await addRevision(b.id, fx.ownerId, utcDay(2026, 6, 7), {
      status: { from: 'todo', to: 'done' },
    }); // B real burn

    const series = await reportsService.getBurndownSeries(sprint.id, fx.ctx);
    const at = byDate(series.days);

    // The actual line: not-done at start = B+C = 49; flat across E's done-add;
    // drops to 19 when B burns; ends at the authoritative roll-up remaining. The
    // roll-up: current members A,B,C,E = 90 pts, A+B+E done = 71 → remaining 19
    // (only C is not done) — the chart and the numeric remaining agree.
    expect(at('2026-06-02').remaining).toBe(49);
    expect(at('2026-06-04').remaining).toBe(49); // E added but already done → flat
    expect(at('2026-06-07').remaining).toBe(19); // B (30) done
    expect(series.days[9]!.remaining).toBe(19); // == rollupForSprint().remaining
  });

  it('a sprint with NO committed snapshot (committedPoints null) still draws the points series anchored to the real remaining (the live Sprint-31 condition)', async () => {
    // The EXACT production cause of MOTIR-1285: Sprint 31 was active with
    // `committedPoints = null` (never start-snapshotted) but real points work, so
    // the burndown degraded to a unitless ISSUE-COUNT series that never anchored —
    // it showed ~40+ while the scrum header showed 21 points left. The fix: a
    // points project with points work draws the POINTS series anchored to
    // `rollupForSprint().remaining`, even with no snapshot. A big already-`done`
    // block (240 pts) is moved in to also exercise the no-plateau behaviour.
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'S31-shape' }, fx.ctx);
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A (burns in-sprint)' });
    const b = await createTestWorkItem(fx, { kind: 'task', title: 'B (the real remaining)' });
    const big = await createTestWorkItem(fx, { kind: 'task', title: 'BIG (done block moved in)' });

    await place(a.id, sprint.id, 'done', 30); // not done at start, burns mid-sprint
    await place(b.id, sprint.id, 'todo', 21); // the true remaining
    await place(big.id, sprint.id, 'done', 240); // a done block moved in mid-sprint
    // NO committed snapshot — the live Sprint-31 condition that caused the degrade.
    await stampSprint(sprint.id, {
      state: 'complete',
      startDate: utcDay(2026, 6, 1),
      endDate: utcDay(2026, 6, 10),
      completedAt: utcDay(2026, 6, 10),
      committedPoints: null,
      committedIssueCount: 2,
    });
    await addRevision(big.id, fx.ownerId, utcDay(2026, 5, 15), {
      status: { from: 'todo', to: 'done' },
    }); // BIG completed long before it joined
    await addRevision(big.id, fx.ownerId, utcDay(2026, 6, 5), {
      sprintId: { from: null, to: sprint.id },
    }); // BIG (240, already done) moved into the sprint
    await addRevision(a.id, fx.ownerId, utcDay(2026, 6, 6), {
      status: { from: 'todo', to: 'done' },
    }); // A real burn

    const series = await reportsService.getBurndownSeries(sprint.id, fx.ctx);
    const at = byDate(series.days);

    // Despite no committed snapshot, it draws the POINTS series (NOT issue_count)
    // and reconciles to the points remaining. Roll-up: A,B,BIG = 291 pts, A+BIG
    // done = 270 → remaining 21. committed baseline = the not-done-at-start (51).
    expect(series.statistic).toBe('story_points');
    expect(series.committed).toBe(51); // derived not-done-at-start (A+B), not 0
    expect(at('2026-06-02').remaining).toBe(51); // A+B not done at start
    expect(at('2026-06-05').remaining).toBe(51); // BIG moved in (done) → flat, no spike
    expect(at('2026-06-06').remaining).toBe(21); // A (30) burns → only B left
    expect(series.days[9]!.remaining).toBe(21); // == rollupForSprint().remaining
    expect(Math.max(...series.days.map((d) => d.remaining ?? 0))).toBeLessThanOrEqual(51);
    // The moved-in done block raises no scope-change marker (it adds 0 remaining).
    expect(series.scopeChanges).toEqual([]);
  });

  it('a sprint started EMPTY/unestimated then populated still RENDERS (committed never collapses to 0)', async () => {
    // Regression: a sprint with no committed snapshot whose not-`done`-at-start
    // points are 0 (started empty, or started with unestimated items, then
    // populated later) must NOT yield `committed === 0` — that is the chart's
    // "nothing committed" EMPTY state, i.e. a blank burndown despite real
    // remaining work. The committed baseline must stay at least the current
    // remaining so the points series renders.
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'EmptyStart' }, fx.ctx);
    const b = await createTestWorkItem(fx, { kind: 'task', title: 'B (added after start)' });

    // Started with NOTHING (no snapshot); B (todo, 21) moved in mid-sprint.
    await place(b.id, sprint.id, 'todo', 21);
    await stampSprint(sprint.id, {
      state: 'complete',
      startDate: utcDay(2026, 6, 1),
      endDate: utcDay(2026, 6, 10),
      completedAt: utcDay(2026, 6, 10),
      committedPoints: null,
      committedIssueCount: 0,
    });
    await addRevision(b.id, fx.ownerId, utcDay(2026, 6, 5), {
      sprintId: { from: null, to: sprint.id },
    });

    const series = await reportsService.getBurndownSeries(sprint.id, fx.ctx);
    expect(series.statistic).toBe('story_points');
    expect(series.committed).toBeGreaterThan(0); // NOT the empty-state 0 → chart renders
    expect(series.days[9]!.remaining).toBe(21); // still reconciles to the real remaining
  });
});

describe('reportsService.getBurndownSeries — degraded + edge states', () => {
  it('degrades a wholly unestimated sprint to the issue-count series (never NaN)', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'NoPts' }, fx.ctx);
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A' });
    const b = await createTestWorkItem(fx, { kind: 'task', title: 'B' });
    const c = await createTestWorkItem(fx, { kind: 'task', title: 'C' });
    await place(a.id, sprint.id, 'done', null);
    await place(b.id, sprint.id, 'todo', null);
    await place(c.id, sprint.id, 'todo', null);
    await stampSprint(sprint.id, {
      state: 'complete',
      startDate: utcDay(2026, 6, 1),
      endDate: utcDay(2026, 6, 5),
      completedAt: utcDay(2026, 6, 5),
      committedPoints: null, // no point baseline
      committedIssueCount: 3,
    });
    await addRevision(a.id, fx.ownerId, utcDay(2026, 6, 3), {
      status: { from: 'todo', to: 'done' },
    });

    const series = await reportsService.getBurndownSeries(sprint.id, fx.ctx);
    expect(series.statistic).toBe('issue_count');
    expect(series.committed).toBe(3); // committedIssueCount
    expect(series.days.every((d) => d.remaining === null || Number.isFinite(d.remaining))).toBe(
      true,
    );
    expect(byDate(series.days)('2026-06-03').remaining).toBe(2); // one issue closed: 3 → 2
  });

  it('uses the issue-count series when the project statistic is issue_count', async () => {
    const fx = await makeWorkItemFixture();
    await db.project.update({
      where: { id: fx.projectId },
      data: { estimationStatistic: 'issue_count' },
    });
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Count' }, fx.ctx);
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A' });
    const b = await createTestWorkItem(fx, { kind: 'task', title: 'B' });
    await place(a.id, sprint.id, 'done', 5); // points present but ignored (count statistic)
    await place(b.id, sprint.id, 'todo', 8);
    await stampSprint(sprint.id, {
      state: 'complete',
      startDate: utcDay(2026, 6, 1),
      endDate: utcDay(2026, 6, 5),
      completedAt: utcDay(2026, 6, 5),
      committedPoints: 13,
      committedIssueCount: 2,
    });
    await addRevision(a.id, fx.ownerId, utcDay(2026, 6, 3), {
      status: { from: 'todo', to: 'done' },
    });

    const series = await reportsService.getBurndownSeries(sprint.id, fx.ctx);
    expect(series.statistic).toBe('issue_count');
    expect(series.committed).toBe(2);
    expect(byDate(series.days)('2026-06-03').remaining).toBe(1); // one issue done: 2 → 1
    expect(series.days[series.days.length - 1]!.remaining).toBe(1); // == rollup.remaining (anchored)
  });

  it('an empty sprint is a flat guideline at 0', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Empty' }, fx.ctx);
    await stampSprint(sprint.id, {
      state: 'complete',
      startDate: utcDay(2026, 6, 1),
      endDate: utcDay(2026, 6, 4),
      completedAt: utcDay(2026, 6, 4),
      committedPoints: null,
      committedIssueCount: 0,
    });
    const series = await reportsService.getBurndownSeries(sprint.id, fx.ctx);
    expect(series.committed).toBe(0);
    expect(series.days).toHaveLength(4);
    expect(series.days.every((d) => d.guideline === 0 && d.remaining === 0)).toBe(true);
    expect(series.scopeChanges).toEqual([]);
  });

  it('handles a single-day sprint (guideline stays at the baseline)', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'OneDay' }, fx.ctx);
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A' });
    await place(a.id, sprint.id, 'todo', 5);
    await stampSprint(sprint.id, {
      state: 'complete',
      startDate: utcDay(2026, 6, 1),
      endDate: utcDay(2026, 6, 1),
      completedAt: utcDay(2026, 6, 1),
      committedPoints: 5,
      committedIssueCount: 1,
    });
    const series = await reportsService.getBurndownSeries(sprint.id, fx.ctx);
    expect(series.days).toHaveLength(1);
    expect(series.days[0]!.guideline).toBe(5);
    expect(series.days[0]!.remaining).toBe(5); // nothing done → flat at committed
  });

  it('degrades a time_estimate project to the issue-count series WITHOUT anchoring to the points roll-up', async () => {
    // A time_estimate project has no committed-time snapshot (4.6.3's documented
    // narrowing), so the series degrades to issue_count — and because the drawn
    // statistic differs from the project statistic, the end point must come from
    // the revision trail alone, NOT be pinned to `rollupForSprint().remaining`
    // (which would be in minutes).
    const fx = await makeWorkItemFixture();
    await db.project.update({
      where: { id: fx.projectId },
      data: { estimationStatistic: 'time_estimate' },
    });
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Time' }, fx.ctx);
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A' });
    const b = await createTestWorkItem(fx, { kind: 'task', title: 'B' });
    await place(a.id, sprint.id, 'done', null);
    await place(b.id, sprint.id, 'todo', null);
    await stampSprint(sprint.id, {
      state: 'complete',
      startDate: utcDay(2026, 6, 1),
      endDate: utcDay(2026, 6, 5),
      completedAt: utcDay(2026, 6, 5),
      committedPoints: 13, // present, but a time project never burns points
      committedIssueCount: 2,
    });
    await addRevision(a.id, fx.ownerId, utcDay(2026, 6, 3), {
      status: { from: 'todo', to: 'done' },
    });

    const series = await reportsService.getBurndownSeries(sprint.id, fx.ctx);
    expect(series.statistic).toBe('issue_count');
    expect(series.committed).toBe(2);
    // Trail-derived: 2 committed, one done on 06-03 → 1 — finite end to end.
    expect(byDate(series.days)('2026-06-03').remaining).toBe(1);
    expect(series.days[series.days.length - 1]!.remaining).toBe(1);
  });

  it('a zero point baseline degrades to issue-count (the committedPoints === 0 branch)', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'ZeroPts' }, fx.ctx);
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A' });
    await place(a.id, sprint.id, 'todo', null);
    await stampSprint(sprint.id, {
      state: 'complete',
      startDate: utcDay(2026, 6, 1),
      endDate: utcDay(2026, 6, 3),
      completedAt: utcDay(2026, 6, 3),
      committedPoints: 0, // a stamped-but-zero baseline is no baseline
      committedIssueCount: 1,
    });
    const series = await reportsService.getBurndownSeries(sprint.id, fx.ctx);
    expect(series.statistic).toBe('issue_count');
    expect(series.committed).toBe(1);
  });

  it('a null committedIssueCount reads as 0 committed, never NaN (the ?? 0 guard)', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'NoBase' }, fx.ctx);
    await stampSprint(sprint.id, {
      state: 'complete',
      startDate: utcDay(2026, 6, 1),
      endDate: utcDay(2026, 6, 3),
      completedAt: utcDay(2026, 6, 3),
      committedPoints: null,
      committedIssueCount: null, // defensive — a started sprint normally has one
    });
    const series = await reportsService.getBurndownSeries(sprint.id, fx.ctx);
    expect(series.committed).toBe(0);
    expect(series.days.every((d) => d.guideline === 0)).toBe(true);
  });

  it('an OVERRUN active sprint extends the axis to today (actual drawn past the planned end)', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Overrun' }, fx.ctx);
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A' });
    await place(a.id, sprint.id, 'todo', 5);
    const now = new Date();
    await stampSprint(sprint.id, {
      state: 'active',
      startDate: new Date(now.getTime() - 6 * DAY_MS),
      endDate: new Date(now.getTime() - 2 * DAY_MS), // planned end already passed
      completedAt: null,
      committedPoints: 5,
      committedIssueCount: 1,
    });
    const series = await reportsService.getBurndownSeries(sprint.id, fx.ctx);
    const todayKey = now.toISOString().slice(0, 10);
    // The axis covers TODAY (not just the overrun planned end) and today is drawn.
    expect(series.days[series.days.length - 1]!.date).toBe(todayKey);
    expect(series.days[series.days.length - 1]!.remaining).toBe(5);
  });

  it('falls back to completedAt for the axis end when a completed sprint has no planned end date', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'NoEnd' }, fx.ctx);
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A' });
    await place(a.id, sprint.id, 'todo', 5);
    await stampSprint(sprint.id, {
      state: 'complete',
      startDate: utcDay(2026, 6, 1),
      endDate: null, // no planned end — the axis ends at completedAt
      completedAt: utcDay(2026, 6, 4),
      committedPoints: 5,
      committedIssueCount: 1,
    });
    const series = await reportsService.getBurndownSeries(sprint.id, fx.ctx);
    expect(series.days).toHaveLength(4); // 06-01 … 06-04
    expect(series.days[3]!.date).toBe('2026-06-04');
    expect(series.days[3]!.remaining).toBe(5);
  });

  it('rejects a not-started (planned) sprint with SprintNotStartedError', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Planned' }, fx.ctx);
    await expect(reportsService.getBurndownSeries(sprint.id, fx.ctx)).rejects.toBeInstanceOf(
      SprintNotStartedError,
    );
  });

  it('404s a sprint outside the active workspace (finding-#26 tenancy gate)', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const otherSprint = await sprintsService.createSprint(
      other.projectId,
      { name: 'X' },
      other.ctx,
    );
    await stampSprint(otherSprint.id, {
      state: 'complete',
      startDate: utcDay(2026, 6, 1),
      endDate: utcDay(2026, 6, 4),
      completedAt: utcDay(2026, 6, 4),
      committedPoints: 0,
      committedIssueCount: 0,
    });
    await expect(reportsService.getBurndownSeries(otherSprint.id, fx.ctx)).rejects.toBeInstanceOf(
      SprintNotFoundError,
    );
  });
});

describe('workItemRevisionRepository.aggregateSprintBurndownByDay — bounded + empty-input guard', () => {
  it('returns one row PER DAY (grouped server-side), not one per revision', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Bucket' }, fx.ctx);
    const items = await Promise.all(
      [1, 2, 3].map((n) => createTestWorkItem(fx, { kind: 'task', title: `I${n}` })),
    );
    for (const it of items) await place(it.id, sprint.id, 'done', 2);
    // Three completions on ONE day + one on another.
    for (const it of items) {
      await addRevision(it.id, fx.ownerId, utcDay(2026, 6, 3), {
        status: { from: 'todo', to: 'done' },
      });
    }
    const extra = await createTestWorkItem(fx, { kind: 'task', title: 'I4' });
    await place(extra.id, sprint.id, 'done', 2);
    await addRevision(extra.id, fx.ownerId, utcDay(2026, 6, 5), {
      status: { from: 'todo', to: 'done' },
    });

    const rows = await workItemRevisionRepository.aggregateSprintBurndownByDay(
      sprint.id,
      fx.workspaceId,
      { start: utcDay(2026, 6, 1), end: utcDay(2026, 6, 10) },
      false,
    );
    expect(rows).toHaveLength(2); // TWO event-days, not FOUR revisions
    expect(rows.find((r) => r.day === '2026-06-03')!.remainingDelta).toBe(-6); // 3 × 2 pts burned
    expect(rows.find((r) => r.day === '2026-06-05')!.remainingDelta).toBe(-2);
  });

  it('returns no rows for a sprint with no qualifying revisions (the flat-at-committed guard)', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'NoRevs' }, fx.ctx);
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'A' });
    await place(a.id, sprint.id, 'todo', 5);
    const rows = await workItemRevisionRepository.aggregateSprintBurndownByDay(
      sprint.id,
      fx.workspaceId,
      { start: utcDay(2026, 6, 1), end: utcDay(2026, 6, 10) },
      false,
    );
    expect(rows).toEqual([]);
  });
});

// ── Route transport (GET /api/sprints/[id]/burndown) ────────────────────────
const wsCtx = { current: null as WorkspaceContext | null };
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => wsCtx.current };
});
const { GET } = await import('@/app/api/sprints/[id]/burndown/route');

function req(id: string): Promise<Response> {
  return GET(new Request(`http://localhost:3000/api/sprints/${id}/burndown`), {
    params: Promise.resolve({ id }),
  });
}

describe('GET /api/sprints/[id]/burndown — transport', () => {
  beforeEach(() => {
    wsCtx.current = null;
  });

  it('200s with the series for a started sprint', async () => {
    const fx = await makeWorkItemFixture();
    wsCtx.current = fx.ctx;
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'S' }, fx.ctx);
    await stampSprint(sprint.id, {
      state: 'complete',
      startDate: utcDay(2026, 6, 1),
      endDate: utcDay(2026, 6, 4),
      completedAt: utcDay(2026, 6, 4),
      committedPoints: 0,
      committedIssueCount: 0,
    });
    const res = await req(sprint.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sprintId).toBe(sprint.id);
    expect(Array.isArray(body.days)).toBe(true);
  });

  it('409s a planned (not-started) sprint', async () => {
    const fx = await makeWorkItemFixture();
    wsCtx.current = fx.ctx;
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'P' }, fx.ctx);
    const res = await req(sprint.id);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('SPRINT_NOT_STARTED');
  });

  it('404s a cross-workspace sprint', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other2', identifier: 'OTH2' });
    const otherSprint = await sprintsService.createSprint(
      other.projectId,
      { name: 'X' },
      other.ctx,
    );
    wsCtx.current = fx.ctx;
    const res = await req(otherSprint.id);
    expect(res.status).toBe(404);
  });

  it('401s when unauthenticated', async () => {
    wsCtx.current = null;
    const res = await req('any');
    expect(res.status).toBe(401);
  });
});
