import { describe, expect, it } from 'vitest';
import type { CoverageNodeInfo } from '@/lib/workItems/crossParentCoverage';
import { edgeDisposition, isFlaggedDisposition } from '@/lib/workItems/edgeDisposition';

// MOTIR-6359 — what the roadmap draws for an off-level edge, from the validators'
// own two predicates. Tree: epics E1, E2; stories A, B under E1 and C under E2;
// subtasks a1 (A), b1 (B), c1 (C); roots R, F (F is a filed root, parent null).
const TREE: Record<string, CoverageNodeInfo> = {
  E1: { parentId: null, ancestors: [], kind: 'epic' },
  E2: { parentId: null, ancestors: [], kind: 'epic' },
  A: { parentId: 'E1', ancestors: ['E1'], kind: 'story' },
  B: { parentId: 'E1', ancestors: ['E1'], kind: 'story' },
  C: { parentId: 'E2', ancestors: ['E2'], kind: 'story' },
  a1: { parentId: 'A', ancestors: ['A', 'E1'], kind: 'subtask' },
  a2: { parentId: 'A', ancestors: ['A', 'E1'], kind: 'subtask' },
  b1: { parentId: 'B', ancestors: ['B', 'E1'], kind: 'subtask' },
  c1: { parentId: 'C', ancestors: ['C', 'E2'], kind: 'subtask' },
  R: { parentId: null, ancestors: [], kind: 'task' },
  F: { parentId: null, ancestors: [], kind: 'task' },
};
const info = (id: string) => TREE[id];
const links = (...pairs: Array<[string, string]>) => {
  const set = new Set(pairs.map(([a, b]) => `${a}>${b}`));
  return (a: string, b: string) => set.has(`${a}>${b}`);
};

describe('edgeDisposition (MOTIR-6359)', () => {
  it('UNCOVERED when the blocked parent is not directly blocked_by the blocker parent', () => {
    expect(edgeDisposition({ blockedId: 'b1', blockerId: 'a1' }, info, links())).toBe('uncovered');
  });

  it('COVERED when the parents carry the edge — direct, in the right direction', () => {
    expect(edgeDisposition({ blockedId: 'b1', blockerId: 'a1' }, info, links(['B', 'A']))).toBe(
      'covered',
    );
    // the reverse parent edge does not cover it
    expect(edgeDisposition({ blockedId: 'b1', blockerId: 'a1' }, info, links(['A', 'B']))).toBe(
      'uncovered',
    );
  });

  it('a grandparent edge does NOT cover a subtask edge; the story edge is judged on its own', () => {
    expect(edgeDisposition({ blockedId: 'c1', blockerId: 'a1' }, info, links(['E2', 'E1']))).toBe(
      'uncovered',
    );
    expect(edgeDisposition({ blockedId: 'C', blockerId: 'A' }, info, links(['E2', 'E1']))).toBe(
      'covered',
    );
  });

  it('CROSS-LEVEL first, even when the parents happen to be linked', () => {
    expect(edgeDisposition({ blockedId: 'b1', blockerId: 'C' }, info, links(['B', 'E2']))).toBe(
      'cross_level',
    );
    // an epic pairs only with an epic
    expect(edgeDisposition({ blockedId: 'R', blockerId: 'E1' }, info, links())).toBe('cross_level');
  });

  it('EXEMPT when an end has no work-item parent, or both share one', () => {
    expect(edgeDisposition({ blockedId: 'R', blockerId: 'F' }, info, links())).toBe('exempt');
    expect(edgeDisposition({ blockedId: 'a2', blockerId: 'a1' }, info, links())).toBe('exempt');
  });

  it('undefined when an end cannot be described', () => {
    expect(edgeDisposition({ blockedId: 'b1', blockerId: 'elsewhere' }, info, links())).toBe(
      undefined,
    );
  });

  it('flags exactly the two invalid dispositions', () => {
    expect(
      (['covered', 'exempt', 'uncovered', 'cross_level'] as const).filter(isFlaggedDisposition),
    ).toEqual(['uncovered', 'cross_level']);
  });
});
