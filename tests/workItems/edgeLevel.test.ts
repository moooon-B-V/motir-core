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

describe('isCrossLevelEdge — the record’s worked cases', () => {
  it('1 · a validation task under an epic → the story beside it: SAME level', () => {
    expect(isCrossLevelEdge(chain.T, chain.S)).toBe(false);
  });
  it('2 · a subtask under a task → a subtask under a story, same epic: SAME level', () => {
    expect(isCrossLevelEdge(chain.X, chain.Y)).toBe(false);
  });
  it('2b · the same across epics: SAME level (depth 3 / 3 below the root)', () => {
    expect(isCrossLevelEdge(chain.X, chain.Y2)).toBe(false);
  });
  it('3 · a subtask under a task under a story → a subtask under a story: CROSS-level', () => {
    expect(isCrossLevelEdge(chain.X1, chain.Y)).toBe(true);
  });
  it('4 · a root bug in a folder → a subtask: CROSS-level', () => {
    expect(isCrossLevelEdge(chain.B, chain.Y)).toBe(true);
  });
  it('4b · a subtask under a ROOT task → a subtask under a story under an epic: CROSS-level', () => {
    expect(isCrossLevelEdge(chain.XR, chain.Y)).toBe(true);
  });
  it('two roots are always on one level, and the rule is symmetric', () => {
    expect(isCrossLevelEdge(chain.R, chain.E1)).toBe(false);
    expect(isCrossLevelEdge(chain.Y, chain.X1)).toBe(isCrossLevelEdge(chain.X1, chain.Y));
  });
  it('a child and its own parent are never on one level', () => {
    expect(isCrossLevelEdge(chain.Y, chain.S)).toBe(true);
  });
});

describe('assertLinkSameLevel', () => {
  it('refuses a cross-level blocked_by with both keys and depths', () => {
    try {
      assertLinkSameLevel(
        'is_blocked_by',
        { identifier: 'ACME-9', ancestors: chain.X1 },
        { identifier: 'ACME-2', ancestors: chain.Y },
      );
      expect.unreachable('a cross-level edge must be refused');
    } catch (err) {
      expect(err).toBeInstanceOf(CrossLevelLinkError);
      expect((err as Error).message).toContain('ACME-9 sits 3 level(s)');
      expect((err as Error).message).toContain('ACME-2 sits 2');
    }
  });
  it('never judges another link kind, and passes a same-level edge', () => {
    expect(() =>
      assertLinkSameLevel(
        'relates_to',
        { identifier: 'A', ancestors: chain.X1 },
        { identifier: 'B', ancestors: [] },
      ),
    ).not.toThrow();
    expect(() =>
      assertLinkSameLevel(
        'is_blocked_by',
        { identifier: 'A', ancestors: chain.T },
        { identifier: 'B', ancestors: chain.S },
      ),
    ).not.toThrow();
  });
});
