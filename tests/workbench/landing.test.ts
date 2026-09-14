import { describe, expect, it } from 'vitest';
import {
  resolveWorkbenchLanding,
  workbenchLandingHref,
  type LandingCounts,
} from '@/lib/workbench/landing';

// THE LANDING CASCADE (Story MOTIR-5213 · MOTIR-5221) — `design/workbench/
// design-notes.md` § 21. Pure, so the whole rule is a truth table here rather
// than a browser walk: every combination of the three counts being zero or not.

describe('resolveWorkbenchLanding — the truth table', () => {
  const cases: Array<[LandingCounts, string]> = [
    // approvals, inProgress, toDo
    [{ approvals: 0, inProgress: 0, toDo: 0 }, 'todo'],
    [{ approvals: 0, inProgress: 0, toDo: 4 }, 'todo'],
    [{ approvals: 0, inProgress: 3, toDo: 0 }, 'in-progress'],
    [{ approvals: 0, inProgress: 3, toDo: 4 }, 'in-progress'],
    [{ approvals: 2, inProgress: 0, toDo: 0 }, 'approvals'],
    [{ approvals: 2, inProgress: 0, toDo: 4 }, 'approvals'],
    [{ approvals: 2, inProgress: 3, toDo: 0 }, 'approvals'],
    [{ approvals: 2, inProgress: 3, toDo: 4 }, 'approvals'],
  ];

  it.each(cases)('%o lands on %s', (counts, expected) => {
    expect(resolveWorkbenchLanding(counts)).toBe(expected);
  });

  it('covers all eight combinations — the table is total, not a sample', () => {
    const seen = new Set(cases.map(([c]) => `${c.approvals > 0}${c.inProgress > 0}${c.toDo > 0}`));
    expect(seen.size).toBe(8);
  });

  it('To do is TERMINAL — landed on even when it is empty too, so the cascade always resolves', () => {
    // A brand-new member: nothing awaiting, nothing moving, nothing to start.
    // They land on the one empty state that carries a way forward.
    expect(resolveWorkbenchLanding({ approvals: 0, inProgress: 0, toDo: 0 })).toBe('todo');
  });

  it('a single item is enough to take a rung — the test is non-zero, not "many"', () => {
    expect(resolveWorkbenchLanding({ approvals: 1, inProgress: 0, toDo: 0 })).toBe('approvals');
    expect(resolveWorkbenchLanding({ approvals: 0, inProgress: 1, toDo: 0 })).toBe('in-progress');
  });

  it('never lands on Recently finished or Watching — they are not rungs', () => {
    const landed = new Set(
      [0, 1].flatMap((a) =>
        [0, 1].flatMap((i) =>
          [0, 1].map((t) => resolveWorkbenchLanding({ approvals: a, inProgress: i, toDo: t })),
        ),
      ),
    );
    expect([...landed].sort()).toEqual(['approvals', 'in-progress', 'todo']);
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
