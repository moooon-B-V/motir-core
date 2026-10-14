import { describe, expect, it } from 'vitest';
import { toReshapePlans } from '@/lib/services/resumeScopeService';

// THE BANNER'S PER-PLAN LINES (Bug MOTIR-8458; `design-notes.md` § 39.3): one line per plan
// approved after the stop, its proposals counted by op, oldest first.

const plan = (id: string, iso: string | null, title: string | null = id) => ({
  id,
  title,
  decidedAt: iso === null ? null : new Date(iso),
});

describe('toReshapePlans', () => {
  it('counts each plan’s proposals by op and orders the plans oldest first', () => {
    const later = plan('p2', '2026-10-14T09:00:00Z');
    const earlier = plan('p1', '2026-10-14T08:00:00Z', null);
    expect(
      toReshapePlans([
        { id: 'a', op: 'add', plan: later },
        { id: 'b', op: 'remove', plan: later },
        { id: 'c', op: 'add', plan: earlier },
        { id: 'd', op: 'modify', plan: earlier },
        { id: 'e', op: 'modify', plan: earlier },
      ]),
    ).toEqual([
      {
        planId: 'p1',
        title: null,
        approvedAt: '2026-10-14T08:00:00.000Z',
        added: 1,
        changed: 2,
        removed: 0,
      },
      {
        planId: 'p2',
        title: 'p2',
        approvedAt: '2026-10-14T09:00:00.000Z',
        added: 1,
        changed: 0,
        removed: 1,
      },
    ]);
  });

  it('counts a proposal matched twice once, and skips a plan with no decision time', () => {
    const p = plan('p', '2026-10-14T08:00:00Z');
    expect(
      toReshapePlans([
        { id: 'a', op: 'add', plan: p },
        { id: 'a', op: 'add', plan: p },
        { id: 'x', op: 'modify', plan: plan('undecided', null) },
      ]).map((line) => [line.planId, line.added]),
    ).toEqual([['p', 1]]);
  });

  it('is empty when nothing re-shaped the story', () => {
    expect(toReshapePlans([])).toEqual([]);
  });
});
