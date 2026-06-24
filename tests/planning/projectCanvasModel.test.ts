import { describe, expect, it } from 'vitest';
import {
  NODE_W,
  breadcrumb,
  childrenOf,
  computeLevel,
  deterministicLayout,
  hasChildren,
  levelOf,
  searchMatches,
  topologicalOrder,
  type ProjectCanvasDep,
  type ProjectCanvasNode,
} from '@/lib/planning/projectCanvasModel';

// A small project forest: epic E1 → stories S1, S2 → subtasks. S1 has T1a, T1b
// (T1b blocked_by T1a); S2 has T2a. A cross-story dep: T2a blocked_by T1a. Content
// is irrelevant to the (structural) model, so it is a placeholder string.
function node(id: string, parentId: string | null, searchText: string): ProjectCanvasNode {
  return { id, parentId, searchText, content: searchText, crumbLabel: id };
}

function forest(): ProjectCanvasNode[] {
  return [
    node('E1', null, 'MOTIR-1 Epic one'),
    node('S1', 'E1', 'MOTIR-2 Story one'),
    node('S2', 'E1', 'MOTIR-3 Story two'),
    node('T1a', 'S1', 'MOTIR-4 Build the engine'),
    node('T1b', 'S1', 'MOTIR-5 Wire the engine'),
    node('T2a', 'S2', 'MOTIR-6 Compose it'),
  ];
}

// T1a is done → its within-story edge is firm; the cross edge is reclassified.
const deps: ProjectCanvasDep[] = [
  { from: 'T1a', to: 'T1b', variant: 'firm' }, // within S1
  { from: 'T1a', to: 'T2a', variant: 'firm' }, // cross story (S1 → S2)
];

describe('childrenOf / hasChildren', () => {
  it('returns the forest roots at the top level', () => {
    expect(childrenOf(forest(), null).map((n) => n.id)).toEqual(['E1']);
  });
  it("returns a node's direct children when focused", () => {
    expect(childrenOf(forest(), 'E1').map((n) => n.id)).toEqual(['S1', 'S2']);
    expect(childrenOf(forest(), 'S1').map((n) => n.id)).toEqual(['T1a', 'T1b']);
  });
  it('treats a node whose parent is absent from the set as a root', () => {
    const partial = [node('T1a', 'S1', 'a'), node('T2a', 'S2', 'b')];
    expect(childrenOf(partial, null).map((n) => n.id)).toEqual(['T1a', 'T2a']);
  });
  it('reports children presence', () => {
    expect(hasChildren(forest(), 'S1')).toBe(true);
    expect(hasChildren(forest(), 'T1a')).toBe(false);
  });
});

describe('computeLevel — drillability + edge classification', () => {
  it('marks nodes with children as drillable', () => {
    const lvl = computeLevel(forest(), deps, 'E1');
    expect(lvl.nodes.map((n) => [n.node.id, n.drillable])).toEqual([
      ['S1', true],
      ['S2', true],
    ]);
  });

  it('keeps a within-parent edge as its consumer variant (firm)', () => {
    const lvl = computeLevel(forest(), deps, 'S1');
    expect(lvl.edges).toEqual([{ from: 'T1a', to: 'T1b', variant: 'firm' }]);
  });

  it('drops edges whose other end is off the current level', () => {
    const lvl = computeLevel(forest(), deps, 'S1');
    expect(lvl.edges.some((e) => e.to === 'T2a')).toBe(false);
  });

  it('reclassifies a cross-PARENT edge as the bad-plan signal when both ends are visible', () => {
    // Render all subtasks as one level (parents absent) → T1a and T2a differ in
    // parentId → the firm hint is overridden to `cross`.
    const subtasks = forest().filter((n) => n.id.startsWith('T'));
    const lvl = computeLevel(subtasks, deps, null);
    const cross = lvl.edges.find((e) => e.to === 'T2a');
    expect(cross).toEqual({ from: 'T1a', to: 'T2a', variant: 'cross' });
  });
});

describe('breadcrumb / levelOf', () => {
  it('builds the root→focus path with crumb labels', () => {
    expect(breadcrumb(forest(), 'T1b').map((c) => c.id)).toEqual(['E1', 'S1', 'T1b']);
    expect(breadcrumb(forest(), 'T1b').map((c) => c.label)).toEqual(['E1', 'S1', 'T1b']);
    expect(breadcrumb(forest(), null)).toEqual([]);
  });
  it('reports the drill level a target lives on', () => {
    expect(levelOf(forest(), 'T1b')).toBe('S1');
    expect(levelOf(forest(), 'E1')).toBe(null);
  });
});

describe('topologicalOrder', () => {
  it('orders blocker before blocked, ties + cycles in input order', () => {
    expect(topologicalOrder(['b', 'a'], [{ from: 'a', to: 'b' }])).toEqual(['a', 'b']);
    expect(
      topologicalOrder(
        ['x', 'y'],
        [
          { from: 'x', to: 'y' },
          { from: 'y', to: 'x' },
        ],
      ),
    ).toEqual(['x', 'y']);
  });
  it('ignores edges to nodes outside the set', () => {
    expect(topologicalOrder(['a'], [{ from: 'a', to: 'ghost' }])).toEqual(['a']);
  });
});

describe('deterministicLayout', () => {
  it('is pure: same input → identical positions', () => {
    const ids = ['a', 'b', 'c'];
    const e = [{ from: 'a', to: 'b' }];
    expect(deterministicLayout(ids, e)).toEqual(deterministicLayout(ids, e));
  });
  it('lays a chain left→right by dependency order', () => {
    const pos = deterministicLayout(
      ['b', 'a', 'c'],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
    );
    expect(pos['a']!.x).toBeLessThan(pos['b']!.x);
    expect(pos['b']!.x).toBeLessThan(pos['c']!.x);
    expect(pos['a']!.y).toBe(pos['b']!.y);
  });
  it('serpentines onto a new row past the column count and keeps nodes apart', () => {
    const pos = deterministicLayout(['n0', 'n1', 'n2', 'n3'], []);
    expect(pos['n3']!.y).toBeGreaterThan(pos['n0']!.y);
    expect(Math.abs(pos['n0']!.x - pos['n1']!.x)).toBeGreaterThanOrEqual(NODE_W);
  });
});

describe('searchMatches', () => {
  it('matches the node searchText, case-insensitive, in input order', () => {
    expect(searchMatches(forest(), 'engine')).toEqual(['T1a', 'T1b']);
    expect(searchMatches(forest(), 'motir-6')).toEqual(['T2a']);
  });
  it('a blank query matches nothing (locate, not filter-to-empty)', () => {
    expect(searchMatches(forest(), '   ')).toEqual([]);
  });
});
