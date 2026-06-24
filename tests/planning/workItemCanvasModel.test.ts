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
  type WorkItemCanvasDep,
  type WorkItemCanvasItem,
} from '@/lib/planning/workItemCanvasModel';

// A small forest: epic E1 → stories S1, S2 → subtasks. S1 has T1a, T1b (T1b
// blocked_by T1a); S2 has T2a. A cross-story dep: T2a blocked_by T1a.
function forest(): WorkItemCanvasItem[] {
  return [
    {
      id: 'E1',
      identifier: 'MOTIR-1',
      title: 'Epic one',
      kind: 'epic',
      status: 'in_progress',
      parentId: null,
    },
    {
      id: 'S1',
      identifier: 'MOTIR-2',
      title: 'Story one',
      kind: 'story',
      status: 'todo',
      parentId: 'E1',
    },
    {
      id: 'S2',
      identifier: 'MOTIR-3',
      title: 'Story two',
      kind: 'story',
      status: 'todo',
      parentId: 'E1',
    },
    {
      id: 'T1a',
      identifier: 'MOTIR-4',
      title: 'Build the engine',
      kind: 'subtask',
      status: 'done',
      parentId: 'S1',
    },
    {
      id: 'T1b',
      identifier: 'MOTIR-5',
      title: 'Wire the engine',
      kind: 'subtask',
      status: 'todo',
      parentId: 'S1',
    },
    {
      id: 'T2a',
      identifier: 'MOTIR-6',
      title: 'Compose it',
      kind: 'subtask',
      status: 'todo',
      parentId: 'S2',
    },
  ];
}

const deps: WorkItemCanvasDep[] = [
  { blockedId: 'T1b', blockerId: 'T1a' }, // within S1
  { blockedId: 'T2a', blockerId: 'T1a' }, // cross story (S2 ← S1)
];

describe('childrenOf / hasChildren', () => {
  it('returns the forest roots at the top level', () => {
    expect(childrenOf(forest(), null).map((i) => i.id)).toEqual(['E1']);
  });
  it("returns a node's direct children when focused", () => {
    expect(childrenOf(forest(), 'E1').map((i) => i.id)).toEqual(['S1', 'S2']);
    expect(childrenOf(forest(), 'S1').map((i) => i.id)).toEqual(['T1a', 'T1b']);
  });
  it('treats an item whose parent is absent from the set as a root', () => {
    const partial: WorkItemCanvasItem[] = [
      {
        id: 'T1a',
        identifier: 'MOTIR-4',
        title: 'a',
        kind: 'subtask',
        status: 'done',
        parentId: 'S1',
      },
      {
        id: 'T2a',
        identifier: 'MOTIR-6',
        title: 'b',
        kind: 'subtask',
        status: 'todo',
        parentId: 'S2',
      },
    ];
    expect(childrenOf(partial, null).map((i) => i.id)).toEqual(['T1a', 'T2a']);
  });
  it('reports children presence', () => {
    expect(hasChildren(forest(), 'S1')).toBe(true);
    expect(hasChildren(forest(), 'T1a')).toBe(false);
  });
});

describe('computeLevel — node drillability + edge classification', () => {
  it('marks nodes with children as drillable', () => {
    const lvl = computeLevel(forest(), deps, 'E1');
    expect(lvl.nodes.map((n) => [n.item.id, n.drillable])).toEqual([
      ['S1', true],
      ['S2', true],
    ]);
  });

  it('classifies a within-story edge: pending when the blocker is not done, firm when done', () => {
    const lvl = computeLevel(forest(), deps, 'S1');
    // T1a (done) blocks T1b → firm; both share parent S1 → not cross
    expect(lvl.edges).toEqual([{ from: 'T1a', to: 'T1b', variant: 'firm' }]);
  });

  it('drops edges whose other end is off the current level', () => {
    // At S1, the cross dep T2a←T1a has T2a off-level → not drawn here
    const lvl = computeLevel(forest(), deps, 'S1');
    expect(lvl.edges.some((e) => e.to === 'T2a')).toBe(false);
  });

  it('flags a cross-PARENT edge as the bad-plan signal when both ends are visible', () => {
    // Render all subtasks as one level (parents absent) → T1a and T2a differ in
    // parentId → the cross variant fires.
    const subtasks = forest().filter((i) => i.kind === 'subtask');
    const lvl = computeLevel(subtasks, deps, null);
    const cross = lvl.edges.find((e) => e.to === 'T2a');
    expect(cross).toEqual({ from: 'T1a', to: 'T2a', variant: 'cross' });
  });
});

describe('breadcrumb / levelOf', () => {
  it('builds the root→focus path', () => {
    expect(breadcrumb(forest(), 'T1b').map((c) => c.id)).toEqual(['E1', 'S1', 'T1b']);
    expect(breadcrumb(forest(), null)).toEqual([]);
  });
  it('reports the drill level a target lives on', () => {
    expect(levelOf(forest(), 'T1b')).toBe('S1');
    expect(levelOf(forest(), 'E1')).toBe(null); // a root → top level
  });
});

describe('topologicalOrder', () => {
  it('orders blocker before blocked, ties + cycles in input order', () => {
    expect(topologicalOrder(['b', 'a'], [{ from: 'a', to: 'b' }])).toEqual(['a', 'b']);
    // a 2-cycle is appended deterministically in input order (a correct plan is a tree)
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
    // topo order a,b,c → strictly increasing x within the first row
    expect(pos['a']!.x).toBeLessThan(pos['b']!.x);
    expect(pos['b']!.x).toBeLessThan(pos['c']!.x);
    expect(pos['a']!.y).toBe(pos['b']!.y);
  });
  it('serpentines onto a new row past the column count and keeps nodes apart', () => {
    const ids = ['n0', 'n1', 'n2', 'n3'];
    const pos = deterministicLayout(ids, []);
    expect(pos['n3']!.y).toBeGreaterThan(pos['n0']!.y); // wrapped to row 2
    expect(Math.abs(pos['n0']!.x - pos['n1']!.x)).toBeGreaterThanOrEqual(NODE_W);
  });
});

describe('searchMatches', () => {
  it('matches identifier or title, case-insensitive, in input order', () => {
    expect(searchMatches(forest(), 'engine')).toEqual(['T1a', 'T1b']);
    expect(searchMatches(forest(), 'motir-6')).toEqual(['T2a']);
  });
  it('a blank query matches nothing (locate, not filter-to-empty)', () => {
    expect(searchMatches(forest(), '   ')).toEqual([]);
  });
});
