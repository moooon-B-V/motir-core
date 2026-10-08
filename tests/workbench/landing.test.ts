import { describe, expect, expectTypeOf, it } from 'vitest';
import type { HomeTabCountsDto } from '@/lib/dto/home';
import {
  resolveWorkbenchLanding,
  workbenchLandingHref,
  type LandingCounts,
} from '@/lib/workbench/landing';

// THE LANDING CASCADE (Story MOTIR-5213 · MOTIR-5221) — `design/workbench/
// design-notes.md` § 21, amended by § 30 (To fix, MOTIR-6604) and § 35 (To resume,
// MOTIR-7712). Pure, so the whole
// rule is a truth table here rather than a browser walk.

describe('resolveWorkbenchLanding — the truth table', () => {
  // Every combination of the FIVE counts being zero or not (To fix joined as the
  // second rung — MOTIR-6604, design § 30 — and To resume as the third, § 35.3). The expected tab is the first non-zero
  // rung in cascade order, To do when none is.
  const RUNGS = [
    ['approvals', 'approvals'],
    ['toFix', 'to-fix'],
    ['toResume', 'to-resume'],
    ['inProgress', 'in-progress'],
  ] as const;
  const cases: Array<[LandingCounts, string]> = [];
  for (const approvals of [0, 2])
    for (const toFix of [0, 5])
      for (const toResume of [0, 2])
        for (const inProgress of [0, 3])
          for (const toDo of [0, 4]) {
            const counts = { approvals, toFix, toResume, inProgress, toDo };
            cases.push([counts, RUNGS.find(([key]) => counts[key] > 0)?.[1] ?? 'todo']);
          }

  it.each(cases)('%o lands on %s', (counts, expected) => {
    expect(resolveWorkbenchLanding(counts)).toBe(expected);
  });

  it('covers all thirty-two combinations — the table is total, not a sample', () => {
    const seen = new Set(
      cases.map(
        ([c]) =>
          `${c.approvals > 0}${c.toFix > 0}${c.toResume > 0}${c.inProgress > 0}${c.toDo > 0}`,
      ),
    );
    expect(seen.size).toBe(32);
  });

  it('pins the rows the rule is about', () => {
    expect(
      resolveWorkbenchLanding({ approvals: 0, toFix: 1, toResume: 0, inProgress: 3, toDo: 4 }),
    ).toBe('to-fix');
    expect(
      resolveWorkbenchLanding({ approvals: 1, toFix: 1, toResume: 0, inProgress: 0, toDo: 0 }),
    ).toBe('approvals');
    expect(
      resolveWorkbenchLanding({ approvals: 0, toFix: 0, toResume: 0, inProgress: 3, toDo: 0 }),
    ).toBe('in-progress');
    // A gated run outranks moving work, and a repair outranks a gated run (§ 35.3).
    expect(
      resolveWorkbenchLanding({ approvals: 0, toFix: 0, toResume: 1, inProgress: 3, toDo: 4 }),
    ).toBe('to-resume');
    expect(
      resolveWorkbenchLanding({ approvals: 0, toFix: 1, toResume: 1, inProgress: 0, toDo: 0 }),
    ).toBe('to-fix');
  });

  it('To do is TERMINAL — landed on even when it is empty too, so the cascade always resolves', () => {
    // A brand-new member: nothing awaiting, nothing stuck, nothing moving, nothing
    // to start. They land on the one empty state that carries a way forward.
    expect(
      resolveWorkbenchLanding({ approvals: 0, toFix: 0, toResume: 0, inProgress: 0, toDo: 0 }),
    ).toBe('todo');
  });

  it('a single item is enough to take a rung — the test is non-zero, not "many"', () => {
    const none = { approvals: 0, toFix: 0, toResume: 0, inProgress: 0, toDo: 0 };
    expect(resolveWorkbenchLanding({ ...none, approvals: 1 })).toBe('approvals');
    expect(resolveWorkbenchLanding({ ...none, toFix: 1 })).toBe('to-fix');
    expect(resolveWorkbenchLanding({ ...none, toResume: 1 })).toBe('to-resume');
    expect(resolveWorkbenchLanding({ ...none, inProgress: 1 })).toBe('in-progress');
  });

  it('never lands on Recently finished or Watching — they are not rungs', () => {
    const landed = new Set(cases.map(([c]) => resolveWorkbenchLanding(c)));
    expect([...landed].sort()).toEqual(['approvals', 'in-progress', 'to-fix', 'to-resume', 'todo']);
  });
});

describe('workbenchLandingHref — where the resolver forwards', () => {
  it('is the landed tab’s own canonical address', () => {
    expect(workbenchLandingHref('approvals', {})).toBe('/workbench?tab=approvals');
    expect(workbenchLandingHref('todo', {})).toBe('/workbench?tab=todo');
  });

  it('carries every OTHER parameter — a pasted `?peek=` still opens over the landed tab', () => {
    expect(workbenchLandingHref('in-progress', { peek: 'MOTIR-7' })).toBe(
      '/workbench?tab=in-progress&peek=MOTIR-7',
    );
    expect(
      workbenchLandingHref('approvals', { approval: 'MOTIR-9', approvalKind: 'design_approval' }),
    ).toBe('/workbench?tab=approvals&approval=MOTIR-9&approvalKind=design_approval');
    expect(workbenchLandingHref('todo', { flag: ['a', 'b'] })).toBe(
      '/workbench?tab=todo&flag=a&flag=b',
    );
  });

  it('drops the unknown `tab` it is replacing, and a `page` that numbered no tab', () => {
    expect(workbenchLandingHref('todo', { tab: 'nonsense', page: '3', peek: 'M-1' })).toBe(
      '/workbench?tab=todo&peek=M-1',
    );
    expect(workbenchLandingHref('todo', { tab: ['x', 'y'], other: undefined })).toBe(
      '/workbench?tab=todo',
    );
  });
});

// PLANNING IS NEVER A RUNG (Story MOTIR-7820 · MOTIR-7828). `HomeTabCountsDto`
// gained a `planning` count for the strip; the cascade must not read it.
describe('the planning count is not a landing input', () => {
  it('lands on To do when the four rungs are zero, however many plans are being written', () => {
    const counts: HomeTabCountsDto = {
      myWork: 0,
      toDo: 0,
      inProgress: 0,
      toFix: 0,
      toResume: 0,
      recentlyFinished: 0,
      approvals: 0,
      watching: 0,
      planning: 5,
    };
    expect(resolveWorkbenchLanding(counts)).toBe('todo');
  });

  it('keeps `planning` out of `LandingCounts` (type-level pin)', () => {
    expectTypeOf<LandingCounts>().not.toHaveProperty('planning');
    type HasPlanning = 'planning' extends keyof LandingCounts ? true : false;
    const hasPlanning: HasPlanning = false;
    expect(hasPlanning).toBe(false);
  });
});
