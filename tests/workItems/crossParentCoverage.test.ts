import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  coveredByParents,
  uncoveredCrossParentEdges,
  type CoverageNodeInfo,
} from '@/lib/workItems/crossParentCoverage';

// MOTIR-6370 — a cross-parent edge is VALID only when the parents carry it.
// Pure cases here; the validators' use of it is pinned in
// tests/mcp/cross-parent-coverage.test.ts.

//   E1 ─ A ─ Y        E2 ─ C ─ Z        T (root task)
//      └ B ─ X, W
const parentOfNode: Record<string, string | null> = {
  E1: null,
  E2: null,
  A: 'E1',
  B: 'E1',
  C: 'E2',
  Y: 'A',
  X: 'B',
  W: 'B',
  Z: 'C',
  T: null,
};
// Each node's POSITION (MOTIR-6411): its ancestor chain, nearest first.
const tree: Record<string, CoverageNodeInfo> = Object.fromEntries(
  Object.keys(parentOfNode).map((id) => {
    const ancestors: string[] = [];
    for (let p = parentOfNode[id]; p; p = parentOfNode[p] ?? null) ancestors.push(p);
    return [id, { parentId: parentOfNode[id] ?? null, ancestors }];
  }),
);
const parentOf = (id: string) => tree[id]?.parentId;
const carrying =
  (...pairs: Array<[string, string]>) =>
  (from: string, to: string) =>
    pairs.some(([f, t]) => f === from && t === to);

describe('coveredByParents', () => {
  it('a sibling edge is always covered', () => {
    expect(coveredByParents({ blockedId: 'X', blockerId: 'W' }, parentOf, carrying())).toBe(true);
  });

  it('an edge across parents is covered only when the blocked parent is blocked_by the blocker parent', () => {
    const edge = { blockedId: 'X', blockerId: 'Y' };
    expect(coveredByParents(edge, parentOf, carrying())).toBe(false);
    expect(coveredByParents(edge, parentOf, carrying(['B', 'A']))).toBe(true);
    // The REVERSE parent edge does not cover it — direction matters.
    expect(coveredByParents(edge, parentOf, carrying(['A', 'B']))).toBe(false);
  });

  it('an end with no work-item parent (a root, or a filed item) is exempt', () => {
    expect(coveredByParents({ blockedId: 'X', blockerId: 'T' }, parentOf, carrying())).toBe(true);
    expect(coveredByParents({ blockedId: 'T', blockerId: 'X' }, parentOf, carrying())).toBe(true);
    expect(coveredByParents({ blockedId: 'E1', blockerId: 'E2' }, parentOf, carrying())).toBe(true);
  });

  it('an end the caller cannot place is exempt rather than guessed', () => {
    expect(coveredByParents({ blockedId: 'X', blockerId: 'Q' }, parentOf, carrying())).toBe(true);
  });
});

describe('uncoveredCrossParentEdges', () => {
  const info = (id: string) => tree[id];

  it('reports the uncovered same-level edges only, and asks it of every level', () => {
    const edges = [
      { blockedId: 'X', blockerId: 'Y' }, // subtask across stories — needs B→A
      { blockedId: 'B', blockerId: 'C' }, // story across epics — needs E1→E2
      { blockedId: 'X', blockerId: 'W' }, // siblings
      { blockedId: 'X', blockerId: 'A' }, // cross-LEVEL — not this check's
    ];
    expect(uncoveredCrossParentEdges(edges, info, carrying())).toEqual([
      { blockedId: 'X', blockerId: 'Y' },
      { blockedId: 'B', blockerId: 'C' },
    ]);
    expect(uncoveredCrossParentEdges(edges, info, carrying(['B', 'A'], ['E1', 'E2']))).toEqual([]);
  });

  it('a subtask edge across EPICS owes the story edge — and the story edge then owes the epic edge', () => {
    // X (under B, E1) blocked_by Z (under C, E2), with the story edge drawn but
    // not the epic edge: the subtask edge is covered, the story edge is not.
    const edges = [
      { blockedId: 'X', blockerId: 'Z' },
      { blockedId: 'B', blockerId: 'C' },
    ];
    expect(uncoveredCrossParentEdges(edges, info, carrying(['B', 'C']))).toEqual([
      { blockedId: 'B', blockerId: 'C' },
    ]);
  });

  it('skips an end it cannot describe', () => {
    expect(
      uncoveredCrossParentEdges(
        [{ blockedId: 'X', blockerId: 'nowhere' }],
        (id) => tree[id],
        carrying(),
      ),
    ).toEqual([]);
  });
});

describe('ONE home for the predicate', () => {
  // The roadmap's "blocked elsewhere" signal (MOTIR-6359) must IMPORT this
  // predicate, never re-derive it, so the canvas and the validators cannot
  // disagree. Until that card lands, this pins the half that exists: no other
  // module under lib/ or components/ defines a coverage predicate of its own.
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : /\.tsx?$/.test(name) ? [path] : [];
    });
  }
  it('coveredByParents is defined in exactly one file', () => {
    const root = process.cwd();
    const defining = [...walk(join(root, 'lib')), ...walk(join(root, 'components'))].filter(
      (file) =>
        /function\s+coveredByParents?\b|const\s+coveredByParents?\s*=|function\s+coveredByParentEdge\b/.test(
          readFileSync(file, 'utf8'),
        ),
    );
    expect(defining.map((f) => f.slice(root.length + 1))).toEqual([
      'lib/workItems/crossParentCoverage.ts',
    ]);
  });
});
