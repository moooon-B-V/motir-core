import { describe, expect, it } from 'vitest';
import { toCycleGraphDto, type CycleGraphInput } from '@/lib/mappers/reportsMappers';
import type { CycleGraphDayDto } from '@/lib/dto/reports';

// Story 8.14 · Subtask 8.14.2 — PURE unit tests for the Linear cycle-graph
// assembler (`toCycleGraphDto`). No I/O: the service resolves the live roll-up,
// the window, and the per-day revision-trail deltas; this exercises the math —
// the cumulative scope/completed/started series, the working-day target descent,
// scope-creep, the future-day `null`s, and the degenerate/empty edges. The
// scenario mirrors the 8.14.1 design mock's data table (committedAtStart 42, a
// +4 re-estimate, a 10-working-day window) so the asset and the code agree.

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const at = (days: CycleGraphDayDto[], date: string) => days.find((d) => d.date === date)!;

// Jun 2 2025 is a Monday; Jun 13 is a Friday → a 12-calendar-day window with 10
// working days (Jun 7/8 are the weekend the target holds flat across).
const baseInput: CycleGraphInput = {
  sprintId: 'sprint-1',
  state: 'active',
  statistic: 'story_points',
  start: day('2025-06-02'),
  axisEnd: day('2025-06-13'),
  actualCutoff: day('2025-06-10'), // "today"
  scopeAtStart: 42,
  committedAtStart: 42,
  completedAtStart: 0,
  startedAtStart: 6,
  dailyDeltas: [
    { day: '2025-06-04', scopeDelta: 0, completedDelta: 10, startedDelta: 12 },
    { day: '2025-06-05', scopeDelta: 4, completedDelta: 4, startedDelta: 4 }, // +4 re-estimate
    { day: '2025-06-08', scopeDelta: 0, completedDelta: 4, startedDelta: 6 }, // weekend completion
    { day: '2025-06-10', scopeDelta: 0, completedDelta: 11, startedDelta: 10 },
  ],
};

describe('toCycleGraphDto — target line over working days', () => {
  it('descends committedAtStart → 0 across working days and holds flat on weekends', () => {
    const dto = toCycleGraphDto(baseInput);
    // 12 calendar days, Jun 2 … Jun 13 inclusive.
    expect(dto.days).toHaveLength(12);
    // The exact ideal descent (42 over 10 working days, weekend flat) — matches
    // the design mock's data-table column.
    expect(at(dto.days, '2025-06-02').target).toBe(42); // wd1
    expect(at(dto.days, '2025-06-04').target).toBeCloseTo(32.67, 2); // wd3
    expect(at(dto.days, '2025-06-05').target).toBe(28); // wd4
    expect(at(dto.days, '2025-06-06').target).toBeCloseTo(23.33, 2); // wd5 (Fri)
    expect(at(dto.days, '2025-06-07').target).toBeCloseTo(23.33, 2); // Sat — flat
    expect(at(dto.days, '2025-06-08').target).toBeCloseTo(23.33, 2); // Sun — flat
    expect(at(dto.days, '2025-06-10').target).toBe(14); // wd7
    expect(at(dto.days, '2025-06-13').target).toBe(0); // wd10 — reaches 0
  });

  it('spans the WHOLE window with a non-null target even past the actual cutoff', () => {
    const dto = toCycleGraphDto(baseInput);
    for (const d of dto.days) expect(typeof d.target).toBe('number');
  });

  it('sits flat at the baseline when the window has ≤ 1 working day', () => {
    const dto = toCycleGraphDto({
      ...baseInput,
      start: day('2025-06-07'), // Saturday
      axisEnd: day('2025-06-08'), // Sunday — zero working days
      actualCutoff: day('2025-06-08'),
      dailyDeltas: [],
    });
    for (const d of dto.days) expect(d.target).toBe(42);
  });
});

describe('toCycleGraphDto — cumulative actual series', () => {
  it('cumulates scope/completed/started from the baselines + per-day deltas', () => {
    const dto = toCycleGraphDto(baseInput);
    // Scope: 42 baseline, +4 on Jun 5.
    expect(at(dto.days, '2025-06-02').scope).toBe(42);
    expect(at(dto.days, '2025-06-04').scope).toBe(42);
    expect(at(dto.days, '2025-06-05').scope).toBe(46);
    expect(at(dto.days, '2025-06-10').scope).toBe(46);
    // Completed: 0 → 10 → 14 → 18 (Jun 8) → 29 (Jun 10) — the mock's burn-up.
    expect(at(dto.days, '2025-06-02').completed).toBe(0);
    expect(at(dto.days, '2025-06-04').completed).toBe(10);
    expect(at(dto.days, '2025-06-05').completed).toBe(14);
    expect(at(dto.days, '2025-06-08').completed).toBe(18);
    expect(at(dto.days, '2025-06-10').completed).toBe(29);
    // Started: 6 → 18 → 22 → 28 → 38 — always ≥ completed, ≤ scope.
    expect(at(dto.days, '2025-06-02').started).toBe(6);
    expect(at(dto.days, '2025-06-04').started).toBe(18);
    expect(at(dto.days, '2025-06-10').started).toBe(38);
  });

  it('keeps started between completed and scope on every drawn day (Linear band)', () => {
    const dto = toCycleGraphDto(baseInput);
    for (const d of dto.days) {
      if (d.scope === null) continue;
      expect(d.completed!).toBeLessThanOrEqual(d.started!);
      expect(d.started!).toBeLessThanOrEqual(d.scope!);
    }
  });

  it('reconciles the last drawn scope/completed to the baseline + Σ deltas (header agreement)', () => {
    const dto = toCycleGraphDto(baseInput);
    const sum = (k: 'scopeDelta' | 'completedDelta' | 'startedDelta') =>
      baseInput.dailyDeltas.reduce((s, r) => s + r[k], 0);
    const last = at(dto.days, '2025-06-10'); // the cutoff is the last drawn day
    expect(last.scope).toBe(baseInput.committedAtStart + sum('scopeDelta')); // 46 = live committed
    expect(last.completed).toBe(baseInput.completedAtStart + sum('completedDelta')); // 29 = rollup completed
    expect(last.started).toBe(baseInput.startedAtStart + sum('startedDelta')); // 38
  });

  it('draws actuals only to the cutoff — future days are null, target continues', () => {
    const dto = toCycleGraphDto(baseInput);
    // Jun 11–13 are after the Jun 10 cutoff.
    for (const date of ['2025-06-11', '2025-06-12', '2025-06-13']) {
      const d = at(dto.days, date);
      expect(d.scope).toBeNull();
      expect(d.completed).toBeNull();
      expect(d.started).toBeNull();
      expect(typeof d.target).toBe('number');
    }
  });

  it('floors each series at 0 (a net-negative delta never goes below zero)', () => {
    const dto = toCycleGraphDto({
      ...baseInput,
      completedAtStart: 2,
      dailyDeltas: [{ day: '2025-06-04', scopeDelta: -50, completedDelta: -10, startedDelta: -10 }],
    });
    expect(at(dto.days, '2025-06-04').scope).toBe(0);
    expect(at(dto.days, '2025-06-04').completed).toBe(0);
    expect(at(dto.days, '2025-06-04').started).toBe(0);
  });
});

describe('toCycleGraphDto — scope creep', () => {
  it('is (currentScope − committedAtStart) / committedAtStart', () => {
    const dto = toCycleGraphDto(baseInput);
    expect(dto.scopeCreepPct).toBeCloseTo(4 / 42, 4); // (46 − 42) / 42 ≈ 0.0952
    expect(dto.committedAtStart).toBe(42);
  });

  it('is 0 (never NaN/Infinity) when there was no committed scope at start', () => {
    const dto = toCycleGraphDto({
      ...baseInput,
      scopeAtStart: 0,
      committedAtStart: 0,
      completedAtStart: 0,
      startedAtStart: 0,
      dailyDeltas: [{ day: '2025-06-04', scopeDelta: 8, completedDelta: 0, startedDelta: 0 }],
    });
    expect(dto.scopeCreepPct).toBe(0);
    expect(Number.isFinite(dto.scopeCreepPct)).toBe(true);
  });

  it('decouples the TARGET origin from the scope-series baseline so the target never collapses onto the x-axis', () => {
    // The bug scenario (start-then-populate): the trail says ALL scope was added
    // after start, so `scopeAtStart` reconstructs to 0 — but the service supplies
    // a real `committedAtStart` (the startSprint snapshot / live scope), so the
    // target still descends instead of lying flat at 0.
    const dto = toCycleGraphDto({
      ...baseInput,
      scopeAtStart: 0, // the scope series legitimately starts at 0 (trail)
      committedAtStart: 46, // the target's origin = the real committed scope
      completedAtStart: 0,
      startedAtStart: 0,
      dailyDeltas: [{ day: '2025-06-04', scopeDelta: 46, completedDelta: 0, startedDelta: 0 }],
    });
    // The TARGET descends from 46 — NOT pinned to the x-axis.
    expect(dto.days[0]!.target).toBe(46);
    expect(dto.days[0]!.target).toBeGreaterThan(0);
    expect(Math.min(...dto.days.map((d) => d.target))).toBe(0);
    // The SCOPE series still cumulates from scopeAtStart (0) to currentScope (46).
    expect(at(dto.days, '2025-06-02').scope).toBe(0);
    expect(at(dto.days, '2025-06-04').scope).toBe(46);
    // creep = (46 − 46) / 46 = 0 (no committed-baseline creep).
    expect(dto.scopeCreepPct).toBe(0);
    expect(dto.committedAtStart).toBe(46);
  });
});

describe('toCycleGraphDto — degenerate / empty', () => {
  it('an empty sprint is flat 0 lines, never NaN', () => {
    const dto = toCycleGraphDto({
      ...baseInput,
      scopeAtStart: 0,
      committedAtStart: 0,
      completedAtStart: 0,
      startedAtStart: 0,
      dailyDeltas: [],
    });
    for (const d of dto.days) {
      expect(d.target).toBe(0);
      if (d.scope !== null) {
        expect(d.scope).toBe(0);
        expect(d.completed).toBe(0);
        expect(d.started).toBe(0);
      }
    }
    expect(dto.scopeCreepPct).toBe(0);
  });

  it('collapses an axisEnd-before-start window to the single start day', () => {
    const dto = toCycleGraphDto({
      ...baseInput,
      axisEnd: day('2025-06-01'), // before start
      actualCutoff: day('2025-06-02'),
      dailyDeltas: [],
    });
    expect(dto.days).toHaveLength(1);
    expect(dto.days[0]!.date).toBe('2025-06-02');
  });

  it('carries the window + identity fields through to the DTO', () => {
    const dto = toCycleGraphDto(baseInput);
    expect(dto.sprintId).toBe('sprint-1');
    expect(dto.state).toBe('active');
    expect(dto.statistic).toBe('story_points');
    expect(dto.startDate).toBe(day('2025-06-02').toISOString());
    expect(dto.endDate).toBe(day('2025-06-13').toISOString());
  });
});
