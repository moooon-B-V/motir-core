// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import {
  ProjectRoadmapCanvas,
  type RoadmapLevel,
} from '@/components/planning/ProjectRoadmapCanvas';
import type { ProjectCanvasNode } from '@/lib/planning/projectCanvasModel';

afterEach(() => cleanup());

function node(id: string, label: string, drillable = false): ProjectCanvasNode {
  return {
    id,
    parentId: null,
    searchText: label,
    crumbLabel: id,
    drillable,
    content: <div>{label}</div>,
  };
}

// A 2-level tree served per level: root → [E1 (drillable), E2]; E1 → [S1, S2].
const levels: Record<string, RoadmapLevel> = {
  __root__: { nodes: [node('E1', 'Epic one', true), node('E2', 'Epic two')], deps: [] },
  E1: { nodes: [node('S1', 'Story one'), node('S2', 'Story two')], deps: [] },
};
const loadLevel = (parentId: string | null): Promise<RoadmapLevel> =>
  Promise.resolve(levels[parentId ?? '__root__'] ?? { nodes: [], deps: [] });

function el(id: string) {
  return document.querySelector(`[data-node-id="${id}"]`);
}

describe('ProjectRoadmapCanvas', () => {
  it('renders the root level, bare (no breadcrumb / search) by default', async () => {
    render(<ProjectRoadmapCanvas loadLevel={loadLevel} />);
    expect(await screen.findByText('Epic one')).toBeTruthy();
    expect(el('E2')).toBeTruthy();
    expect(el('S1')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
    expect(screen.queryByRole('search')).toBeNull();
  });

  it('drills into a node (fetching its level), shows the breadcrumb, and Back returns', async () => {
    render(<ProjectRoadmapCanvas loadLevel={loadLevel} rootLabel="Roadmap" />);
    await screen.findByText('Epic one');
    // A click SELECTS (no drill); the explicit "Open" affordance drills.
    fireEvent.keyDown(el('E1')!, { key: 'Enter' });
    expect(el('S1')).toBeNull(); // still on the root level
    fireEvent.click(await screen.findByTestId('drill-button'));
    expect(await screen.findByText('Story one')).toBeTruthy();
    expect(el('S2')).toBeTruthy();
    const crumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumb).getByText('E1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByText('Epic one')).toBeTruthy();
    expect(el('S1')).toBeNull();
  });

  it('calls onSelect for a LEAF node instead of drilling', async () => {
    const onSelect = vi.fn();
    render(<ProjectRoadmapCanvas loadLevel={loadLevel} onSelect={onSelect} />);
    await screen.findByText('Epic two');
    fireEvent.keyDown(el('E2')!, { key: 'Enter' }); // E2 is not drillable
    expect(onSelect).toHaveBeenCalledWith('E2');
  });

  it('selecting a node highlights it + its connections and dims the rest', async () => {
    const level: RoadmapLevel = {
      nodes: [node('A', 'a'), node('B', 'b'), node('C', 'c')],
      deps: [{ from: 'A', to: 'B', variant: 'firm' }], // A↔B connected; C unrelated
    };
    render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(level)} />);
    await screen.findByText('a');
    fireEvent.keyDown(el('A')!, { key: 'Enter' });
    expect(el('A')!.querySelector('[data-selected]')).toBeTruthy(); // A is the selection
    expect(el('B')!.firstElementChild!.className).not.toContain('opacity-35'); // dependency stays lit
    expect(el('C')!.firstElementChild!.className).toContain('opacity-35'); // unrelated dims
  });

  it('search-to-focus highlights a match in the current level', async () => {
    render(<ProjectRoadmapCanvas loadLevel={loadLevel} searchable />);
    await screen.findByText('Epic one');
    fireEvent.change(screen.getByPlaceholderText('Search the roadmap'), {
      target: { value: 'Epic two' },
    });
    expect(el('E2')!.querySelector('[data-highlighted]')).toBeTruthy();
    expect(el('E1')!.querySelector('[data-highlighted]')).toBeNull();
  });

  it('draws a cross-parent edge flag from the level deps', async () => {
    const crossLevel: RoadmapLevel = {
      nodes: [
        { ...node('A', 'a'), parentId: 'P1' },
        { ...node('B', 'b'), parentId: 'P2' },
      ],
      deps: [{ from: 'A', to: 'B', variant: 'cross' }],
    };
    render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(crossLevel)} />);
    await screen.findByText('a');
    expect(screen.getAllByTestId('cross-flag')).toHaveLength(1);
  });

  it('shows the edge legend when the level has dependency edges', async () => {
    const withDeps: RoadmapLevel = {
      nodes: [node('A', 'a'), node('B', 'b')],
      deps: [{ from: 'A', to: 'B', variant: 'firm' }],
    };
    render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(withDeps)} />);
    await screen.findByText('a');
    const legend = screen.getByTestId('edge-legend');
    expect(within(legend).getByText('Dependencies')).toBeTruthy();
    expect(within(legend).getByText('blocks')).toBeTruthy();
    expect(within(legend).getByText('pending')).toBeTruthy();
    expect(within(legend).getByText('cross-story')).toBeTruthy();
  });

  it('hides the legend when there are no edges', async () => {
    render(
      <ProjectRoadmapCanvas
        loadLevel={() => Promise.resolve({ nodes: [node('A', 'a')], deps: [] })}
      />,
    );
    await screen.findByText('a');
    expect(screen.queryByTestId('edge-legend')).toBeNull();
  });

  it('hides the legend when the only edges are `flow` (sequence, not dependency)', async () => {
    // The onboarding station serpentine is drawn but is NOT a blocked-by chain, so
    // it must not surface the "Dependencies" legend.
    const flowOnly: RoadmapLevel = {
      nodes: [node('A', 'a'), node('B', 'b')],
      deps: [{ from: 'A', to: 'B', variant: 'firm', kind: 'flow' }],
    };
    render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(flowOnly)} />);
    await screen.findByText('a');
    expect(screen.queryByTestId('edge-legend')).toBeNull();
  });

  it('shows the empty state when a level has no nodes', async () => {
    render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve({ nodes: [], deps: [] })} />);
    expect(await screen.findByText('Nothing on the roadmap yet')).toBeTruthy();
  });
});
