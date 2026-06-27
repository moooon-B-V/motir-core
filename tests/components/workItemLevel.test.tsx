// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { buildWorkItemLevel } from '@/components/planning/workItemLevel';
import type { RoadmapLevelData, RoadmapLevelItem } from '@/lib/planning/roadmapClient';

// The roadmap LEVEL → canvas-node adapter, focused on the Subtask 7.20.6 /
// MOTIR-1013 markers it adds for the persistent roadmap: the planning-origin
// cluster at the road's start, the "you are here" current-position marker, and
// the per-container progress meter passed through to each node. (The cross-story
// ghost-anchor behaviour is covered by WorkItemRoadmap.test.) No jest-dom — plain
// vitest assertions + getAttribute.

afterEach(() => cleanup());

function item(over: Partial<RoadmapLevelItem> & { id: string }): RoadmapLevelItem {
  return {
    parentId: null,
    identifier: over.id,
    title: `Title ${over.id}`,
    kind: 'epic',
    status: 'todo',
    hasChildren: false,
    progress: null,
    ...over,
  };
}

function level(items: RoadmapLevelItem[]): RoadmapLevelData {
  return { items, edges: [], offLevelBlockers: [] };
}

const ORIGIN_ID = '__planning_origin__';

describe('buildWorkItemLevel — roadmap markers (MOTIR-1013)', () => {
  it('pins the planning-origin cluster LEFT of the epics when includeOrigin + items exist', () => {
    const { nodes } = buildWorkItemLevel(level([item({ id: 'E1', hasChildren: true })]), {
      includeOrigin: true,
    });
    const origin = nodes.find((n) => n.id === ORIGIN_ID);
    expect(origin).toBeTruthy();
    // Fixed-position (excluded from the auto-layout) and LEFT of the layout origin
    // so the road reads from its completed-planning start; not drillable.
    expect(origin!.x).toBeLessThan(0);
    expect(origin!.drillable).toBeFalsy();
    // It renders the 7.3 stages as milestones.
    render(<>{origin!.content}</>);
    expect(screen.getByTestId('planning-origin')).toBeTruthy();
    expect(screen.getByText('Idea')).toBeTruthy();
    expect(screen.getByText('Plan')).toBeTruthy();
  });

  it('omits the origin without includeOrigin, or when the level has no items', () => {
    expect(
      buildWorkItemLevel(level([item({ id: 'E1' })])).nodes.some((n) => n.id === ORIGIN_ID),
    ).toBe(false);
    expect(
      buildWorkItemLevel(level([]), { includeOrigin: true }).nodes.some((n) => n.id === ORIGIN_ID),
    ).toBe(false);
  });

  it('marks the FIRST in-progress item "you are here" when markActive', () => {
    const { nodes } = buildWorkItemLevel(
      level([
        item({ id: 'E1', status: 'done' }),
        item({ id: 'E2', status: 'in_progress' }),
        item({ id: 'E3', status: 'in_progress' }), // a later in-progress is NOT the marker
      ]),
      { markActive: true },
    );
    const byId = new Map(nodes.map((n) => [n.id, n]));
    render(<>{byId.get('E2')!.content}</>);
    expect(screen.getByText('You are here')).toBeTruthy();
    cleanup();
    render(<>{byId.get('E3')!.content}</>);
    expect(screen.queryByText('You are here')).toBeNull();
  });

  it('does NOT mark "you are here" without markActive (e.g. onboarding)', () => {
    const { nodes } = buildWorkItemLevel(level([item({ id: 'E1', status: 'in_progress' })]));
    render(<>{nodes[0]!.content}</>);
    expect(screen.queryByText('You are here')).toBeNull();
  });

  it('passes a container progress roll-up through to its node meter', () => {
    const { nodes } = buildWorkItemLevel(
      level([item({ id: 'E1', kind: 'epic', hasChildren: true, progress: { done: 3, total: 4 } })]),
    );
    render(<>{nodes[0]!.content}</>);
    expect(screen.getByTestId('progress-meter')).toBeTruthy();
    expect(screen.getByText('3 / 4')).toBeTruthy();
  });
});

// The off-level dependency signal (MOTIR-1331 cross-story; MOTIR-1379 sprint
// validity). In PROJECT scope an off-level blocker is always the cross-story
// tangle. In SPRINT scope it becomes a sprint-validity signal: a DONE or IN-sprint
// blocker is satisfied (not drawn), and only an out-of-sprint, NOT-done blocker is
// flagged — as "not in sprint", not "cross-story".
function levelWithOffBlocker(stub: {
  isDone?: boolean;
  inActiveSprint?: boolean;
}): RoadmapLevelData {
  return {
    items: [item({ id: 'A1', kind: 'subtask' })],
    edges: [{ blockedId: 'A1', blockerId: 'X' }],
    offLevelBlockers: [
      { id: 'X', identifier: 'PROD-9', title: 'External dep', parentTitle: 'Story Z', ...stub },
    ],
  };
}
const A1_FLAG = 'cross-blocked-flag';

describe('buildWorkItemLevel — off-level dependency signal', () => {
  it('PROJECT scope: an off-level blocker is the cross-story tangle (red edge + anchor + flag)', () => {
    const { nodes, deps } = buildWorkItemLevel(levelWithOffBlocker({ isDone: false }));
    expect(deps).toContainEqual({ from: 'X', to: 'A1', variant: 'cross' });
    expect(nodes.some((n) => n.id === 'X')).toBe(true); // ghost anchor
    render(<>{nodes.find((n) => n.id === 'A1')!.content}</>);
    expect(screen.getByTestId(A1_FLAG).textContent).toContain('cross-story');
  });

  it('SPRINT scope: an out-of-sprint, NOT-done blocker is flagged "not in sprint"', () => {
    const { nodes, deps } = buildWorkItemLevel(
      levelWithOffBlocker({ isDone: false, inActiveSprint: false }),
      { scope: 'sprint' },
    );
    expect(deps).toContainEqual({ from: 'X', to: 'A1', variant: 'cross' });
    const anchor = nodes.find((n) => n.id === 'X');
    expect(anchor).toBeTruthy();
    render(<>{anchor!.content}</>);
    expect(screen.getByText(/not in this sprint/)).toBeTruthy();
    cleanup();
    render(<>{nodes.find((n) => n.id === 'A1')!.content}</>);
    expect(screen.getByTestId(A1_FLAG).textContent).toContain('not in sprint');
  });

  it('SPRINT scope: a DONE off-level blocker is satisfied — no edge, no anchor, no flag', () => {
    const { nodes, deps } = buildWorkItemLevel(levelWithOffBlocker({ isDone: true }), {
      scope: 'sprint',
    });
    expect(deps).toEqual([]);
    expect(nodes.some((n) => n.id === 'X')).toBe(false);
    render(<>{nodes.find((n) => n.id === 'A1')!.content}</>);
    expect(screen.queryByTestId(A1_FLAG)).toBeNull();
  });

  it('SPRINT scope: an IN-sprint off-level blocker is satisfied — no edge, no anchor, no flag', () => {
    const { nodes, deps } = buildWorkItemLevel(
      levelWithOffBlocker({ isDone: false, inActiveSprint: true }),
      { scope: 'sprint' },
    );
    expect(deps).toEqual([]);
    expect(nodes.some((n) => n.id === 'X')).toBe(false);
    render(<>{nodes.find((n) => n.id === 'A1')!.content}</>);
    expect(screen.queryByTestId(A1_FLAG)).toBeNull();
  });
});

describe('buildWorkItemLevel — ready highlight (MOTIR-1417)', () => {
  it('a ready node shows the "Ready" pill + the success left bar', () => {
    const { nodes } = buildWorkItemLevel(
      level([item({ id: 'A1', kind: 'subtask', status: 'todo', ready: true })]),
    );
    render(<>{nodes.find((n) => n.id === 'A1')!.content}</>);
    expect(screen.getByTestId('ready-pill')).toBeTruthy();
    expect(screen.getByText('Ready')).toBeTruthy();
    expect(screen.getByTestId('ready-bar')).toBeTruthy();
  });

  it('a NOT-ready node shows the normal status pill, no ready treatment', () => {
    const { nodes } = buildWorkItemLevel(
      level([item({ id: 'A1', kind: 'subtask', status: 'todo', ready: false })]),
    );
    render(<>{nodes.find((n) => n.id === 'A1')!.content}</>);
    expect(screen.queryByTestId('ready-pill')).toBeNull();
    expect(screen.queryByTestId('ready-bar')).toBeNull();
  });

  it('the "you are here" frontier suppresses the ready treatment', () => {
    const { nodes } = buildWorkItemLevel(
      level([item({ id: 'A1', kind: 'story', status: 'in_progress', ready: true })]),
      { markActive: true },
    );
    render(<>{nodes.find((n) => n.id === 'A1')!.content}</>);
    expect(screen.getByText('You are here')).toBeTruthy();
    expect(screen.queryByTestId('ready-pill')).toBeNull();
    expect(screen.queryByTestId('ready-bar')).toBeNull();
  });
});
