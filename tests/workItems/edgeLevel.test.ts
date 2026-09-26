import { describe, expect, it } from 'vitest';
import { assertLinkSameLevel, isCrossLevelEdge } from '@/lib/workItems/edgeLevel';
import { CrossLevelLinkError } from '@/lib/workItems/linkErrors';

// MOTIR-6411 — the level of a `blocked_by` is POSITION (MOTIR-6387,
// `docs/decisions/edge-level-is-position.md`): the same depth below the nearest
// common ancestor. Chains are ancestor ids, NEAREST FIRST. Each case below is a
// row of the record's table.
//
//   E1 ─ S ─ Y          E2 ─ S2 ─ Y2
//      ├ T ─ X
//      ├ S1 ─ T1 ─ X1
//   R (root task) ─ XR
//   B (root bug, filed in a folder — a folder adds no depth)
const chain = {
  E1: [],
  E2: [],
  S: ['E1'],
  T: ['E1'],
  Y: ['S', 'E1'],
  X: ['T', 'E1'],
  S1: ['E1'],
  T1: ['S1', 'E1'],
  X1: ['T1', 'S1', 'E1'],
  S2: ['E2'],
  Y2: ['S2', 'E2'],
  R: [],
  XR: ['R'],
  B: [],
} as const;
const kindOf: Record<keyof typeof chain, string> = {
  E1: 'epic',
  E2: 'epic',
  S: 'story',
  T: 'task',
  Y: 'subtask',
  X: 'subtask',
  S1: 'story',
  T1: 'task',
  X1: 'subtask',
  S2: 'story',
  Y2: 'subtask',
  R: 'task',
  XR: 'subtask',
  B: 'bug',
};
/** One end of an edge — the node's kind and chain. */
const end = (n: keyof typeof chain) => ({ kind: kindOf[n], ancestors: chain[n] });
const cross = (a: keyof typeof chain, b: keyof typeof chain) => isCrossLevelEdge(end(a), end(b));

describe('isCrossLevelEdge — the record’s worked cases', () => {
  it('1 · a validation task under an epic → the story beside it: SAME level', () => {
    expect(cross('T', 'S')).toBe(false);
  });
  it('2 · a subtask under a task → a subtask under a story, same epic: SAME level', () => {
    expect(cross('X', 'Y')).toBe(false);
  });
  it('2b · the same across epics: SAME level (depth 3 / 3 below the root)', () => {
    expect(cross('X', 'Y2')).toBe(false);
  });
  it('3 · a subtask under a task under a story → a subtask under a story: CROSS-level', () => {
    expect(cross('X1', 'Y')).toBe(true);
  });
  it('4 · a root bug in a folder → a subtask: CROSS-level', () => {
    expect(cross('B', 'Y')).toBe(true);
  });
  it('4b · a subtask under a ROOT task → a subtask under a story under an epic: CROSS-level', () => {
    expect(cross('XR', 'Y')).toBe(true);
  });
  it('two non-epic roots are on one level, and the rule is symmetric', () => {
    expect(cross('R', 'B')).toBe(false);
    expect(cross('Y', 'X1')).toBe(cross('X1', 'Y'));
  });
  it('a child and its own parent are never on one level', () => {
    expect(cross('Y', 'S')).toBe(true);
  });
});

describe('Amendment 1 — an epic is blocked only by another epic', () => {
  it('epic → epic is legal', () => {
    expect(cross('E1', 'E2')).toBe(false);
  });
  it('an epic and a root task / bug / story are NOT peers, from either end', () => {
    expect(cross('E1', 'R')).toBe(true);
    expect(cross('R', 'E1')).toBe(true);
    expect(cross('B', 'E1')).toBe(true);
    expect(isCrossLevelEdge({ kind: 'story', ancestors: [] }, end('E2'))).toBe(true);
  });
  it('under an epic the position rule stands — case 4b is still refused, case 1 still legal', () => {
    expect(cross('XR', 'Y')).toBe(true);
    expect(cross('T', 'S')).toBe(false);
  });
});

describe('assertLinkSameLevel', () => {
  it('refuses a cross-level blocked_by with both keys and depths', () => {
    try {
      assertLinkSameLevel(
        'is_blocked_by',
        { identifier: 'ACME-9', ...end('X1') },
        { identifier: 'ACME-2', ...end('Y') },
      );
      expect.unreachable('a cross-level edge must be refused');
    } catch (err) {
      expect(err).toBeInstanceOf(CrossLevelLinkError);
      expect((err as Error).message).toContain('ACME-9 sits 3 level(s)');
      expect((err as Error).message).toContain('ACME-2 sits 2');
    }
  });
  it('refuses an epic paired with a non-epic in the epic-tier words', () => {
    expect(() =>
      assertLinkSameLevel(
        'is_blocked_by',
        { identifier: 'ACME-1', ...end('E1') },
        {
          identifier: 'ACME-7',
          ...end('R'),
        },
      ),
    ).toThrow(/ACME-1 is an epic and ACME-7 is a task\. An epic is blocked only by another epic/);
  });
  it('never judges another link kind, and passes a same-level edge', () => {
    expect(() =>
      assertLinkSameLevel(
        'relates_to',
        { identifier: 'A', ...end('X1') },
        { identifier: 'B', ...end('B') },
      ),
    ).not.toThrow();
    expect(() =>
      assertLinkSameLevel(
        'is_blocked_by',
        { identifier: 'A', ...end('T') },
        { identifier: 'B', ...end('S') },
      ),
    ).not.toThrow();
  });
});
