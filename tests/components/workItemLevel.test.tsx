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
