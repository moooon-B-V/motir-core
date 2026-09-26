import { describe, expect, it } from 'vitest';
import { crossLevelEdgeFindings, isCrossLevelEdge } from '@/lib/workItems/edgeLevel';

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
  it('under an epic the position rule stands — case 4b is still cross-level, case 1 still legal', () => {
    expect(cross('XR', 'Y')).toBe(true);
    expect(cross('T', 'S')).toBe(false);
  });
});

describe('crossLevelEdgeFindings — the verdict both validators report (Amendment 2)', () => {
  const labelled = (n: keyof typeof chain) => ({ ...end(n), label: `ACME-${n}` });
  const lookup = (id: string) => (id in chain ? labelled(id as keyof typeof chain) : undefined);

  it('names each cross-level edge with both depths, the reason and the sentence', () => {
    expect(crossLevelEdgeFindings([{ blockedId: 'X1', blockerId: 'Y' }], lookup)).toEqual([
      {
        item: 'ACME-X1',
        blockedBy: 'ACME-Y',
        itemDepth: 3,
        blockedByDepth: 2,
        reason: 'blocked_elsewhere',
        explanation: expect.stringContaining('ACME-X1 sits 3 level(s)'),
      },
    ]);
  });
  it('words an epic pairing in the epic-tier sentence', () => {
    const [finding] = crossLevelEdgeFindings([{ blockedId: 'E1', blockerId: 'R' }], lookup);
    expect(finding?.explanation).toMatch(
      /ACME-E1 is an epic and ACME-R is a task\. An epic is blocked only by another epic/,
    );
  });
  it('passes a same-level edge, skips an end it cannot place, and sorts by item then blocker', () => {
    expect(
      crossLevelEdgeFindings(
        [
          { blockedId: 'Y', blockerId: 'S' },
          { blockedId: 'T', blockerId: 'S' },
          { blockedId: 'B', blockerId: 'Y' },
          { blockedId: 'B', blockerId: 'X' },
          { blockedId: 'B', blockerId: 'missing' },
        ],
        lookup,
      ).map((f) => [f.item, f.blockedBy]),
    ).toEqual([
      ['ACME-B', 'ACME-X'],
      ['ACME-B', 'ACME-Y'],
      ['ACME-Y', 'ACME-S'],
    ]);
  });
});
