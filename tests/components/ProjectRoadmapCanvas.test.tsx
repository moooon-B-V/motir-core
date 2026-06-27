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

  it('offers Reset layout when ANY node is hand-moved (incl. a fixed-position station), resets only those', async () => {
    const onResetPositions = vi.fn();
    // A is auto-laid; S is a FIXED-position node (explicit x/y, like a root station).
    const level: RoadmapLevel = {
      nodes: [node('A', 'a'), { ...node('S', 's'), x: 5, y: 5 }],
      deps: [],
    };
    // nothing arranged → no reset affordance
    const { rerender } = render(
      <ProjectRoadmapCanvas
        loadLevel={() => Promise.resolve(level)}
        onResetPositions={onResetPositions}
      />,
    );
    await screen.findByText('a');
    expect(screen.queryByRole('button', { name: 'Reset layout' })).toBeNull();
    // a saved position for the STATION (fixed-position) node → the button still
    // appears (so the root "Your project" canvas gets it), and resets only S.
    rerender(
      <ProjectRoadmapCanvas
        loadLevel={() => Promise.resolve(level)}
        positions={{ S: { x: 90, y: 90 } }}
        onResetPositions={onResetPositions}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Reset layout' }));
    expect(onResetPositions).toHaveBeenCalledWith(['S']); // only the arranged node
  });

  it('auto-resets a level when its auto-laid node set changes (a re-plan)', async () => {
    const onResetPositions = vi.fn();
    let levelNodes = [node('A', 'a'), node('B', 'b')];
    const load = () => Promise.resolve({ nodes: levelNodes, deps: [] });
    const { rerender } = render(
      <ProjectRoadmapCanvas loadLevel={load} onResetPositions={onResetPositions} reloadKey="1" />,
    );
    await screen.findByText('a');
    expect(onResetPositions).not.toHaveBeenCalled(); // first render: no prior signature
    // the level's items change → bump reloadKey to refetch
    levelNodes = [node('A', 'a'), node('C', 'c')];
    rerender(
      <ProjectRoadmapCanvas loadLevel={load} onResetPositions={onResetPositions} reloadKey="2" />,
    );
    await screen.findByText('c');
    expect(onResetPositions).toHaveBeenCalledWith(expect.arrayContaining(['A', 'C']));
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

  // The quick-view "View" affordance (Subtask 7.20.11 / MOTIR-1352) — surfaced on
  // the SELECTED card for a `viewable` node when an `onView` handler is wired.
  // Distinct from select (highlight) and from "Open" (drill).
  it('surfaces a View button on a selected viewable node and calls onView with its id', async () => {
    const onView = vi.fn();
    const level: RoadmapLevel = {
      nodes: [{ ...node('V', 'View me'), viewable: true }],
      deps: [],
    };
    render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(level)} onView={onView} />);
    await screen.findByText('View me');
    // Not shown until the card is selected.
    expect(screen.queryByTestId('view-button')).toBeNull();
    fireEvent.keyDown(el('V')!, { key: 'Enter' });
    const view = await screen.findByTestId('view-button');
    expect(view.getAttribute('aria-label')).toBe('View V'); // labelled by identifier
    fireEvent.click(view);
    expect(onView).toHaveBeenCalledWith('V');
  });

  it('surfaces BOTH View and Open on a selected drillable viewable node (View distinct from drill)', async () => {
    const onView = vi.fn();
    const level: RoadmapLevel = {
      nodes: [{ ...node('D', 'Drill me', true), viewable: true }],
      deps: [],
    };
    render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(level)} onView={onView} />);
    await screen.findByText('Drill me');
    fireEvent.keyDown(el('D')!, { key: 'Enter' });
    expect(await screen.findByTestId('view-button')).toBeTruthy();
    expect(screen.getByTestId('drill-button')).toBeTruthy();
  });

  it('shows NO View button on a non-viewable node (e.g. an off-level ghost anchor)', async () => {
    const onView = vi.fn();
    // `node()` omits `viewable` → not viewable.
    const level: RoadmapLevel = { nodes: [node('G', 'ghost')], deps: [] };
    render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(level)} onView={onView} />);
    await screen.findByText('ghost');
    fireEvent.keyDown(el('G')!, { key: 'Enter' });
    expect(screen.queryByTestId('view-button')).toBeNull();
  });

  it('shows NO View button when onView is not wired, even for a viewable node', async () => {
    const level: RoadmapLevel = {
      nodes: [{ ...node('V', 'View me'), viewable: true }],
      deps: [],
    };
    render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(level)} />);
    await screen.findByText('View me');
    fireEvent.keyDown(el('V')!, { key: 'Enter' });
    expect(screen.queryByTestId('view-button')).toBeNull();
  });

  // FULL-SCREEN mode (MOTIR-1420) — opt-in via `fullScreenable`.
  it('does not offer the full-screen toggle by default', async () => {
    render(<ProjectRoadmapCanvas loadLevel={loadLevel} />);
    await screen.findByText('Epic one');
    expect(screen.queryByTestId('fullscreen-toggle')).toBeNull();
  });

  it('expands to full screen (best-effort Fullscreen API + overlay), shows the ESC hint, and ESC exits', async () => {
    // happy-dom has no Fullscreen API — stub the request so the best-effort call is
    // observable; the overlay (data-fullscreen + state) works regardless.
    const requestFs = vi.fn().mockResolvedValue(undefined);
    (Element.prototype as unknown as { requestFullscreen: unknown }).requestFullscreen = requestFs;
    try {
      render(<ProjectRoadmapCanvas loadLevel={loadLevel} fullScreenable />);
      await screen.findByText('Epic one');
      const toggle = screen.getByTestId('fullscreen-toggle');
      const canvas = screen.getByTestId('roadmap-canvas');
      expect(toggle.getAttribute('aria-label')).toBe('Enter full screen');
      expect(screen.queryByTestId('fullscreen-hint')).toBeNull();
      expect(canvas.hasAttribute('data-fullscreen')).toBe(false);

      fireEvent.click(toggle);
      expect(requestFs).toHaveBeenCalled(); // Fullscreen API attempted
      expect(toggle.getAttribute('aria-label')).toBe('Exit full screen');
      expect(toggle.getAttribute('aria-pressed')).toBe('true');
      expect(canvas.getAttribute('data-fullscreen')).toBe('true');
      expect(canvas.className).toContain('fixed');
      expect(screen.getByTestId('fullscreen-hint')).toBeTruthy();

      // ESC exits (the overlay-path keydown handler).
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(toggle.getAttribute('aria-label')).toBe('Enter full screen');
      expect(screen.queryByTestId('fullscreen-hint')).toBeNull();
      expect(canvas.hasAttribute('data-fullscreen')).toBe(false);
    } finally {
      delete (Element.prototype as unknown as { requestFullscreen?: unknown }).requestFullscreen;
    }
  });

  it('the Exit button collapses full screen', async () => {
    (Element.prototype as unknown as { requestFullscreen: unknown }).requestFullscreen = vi
      .fn()
      .mockResolvedValue(undefined);
    try {
      render(<ProjectRoadmapCanvas loadLevel={loadLevel} fullScreenable />);
      await screen.findByText('Epic one');
      const toggle = screen.getByTestId('fullscreen-toggle');
      fireEvent.click(toggle);
      expect(toggle.getAttribute('aria-label')).toBe('Exit full screen');
      fireEvent.click(toggle);
      expect(toggle.getAttribute('aria-label')).toBe('Enter full screen');
      expect(screen.getByTestId('roadmap-canvas').hasAttribute('data-fullscreen')).toBe(false);
    } finally {
      delete (Element.prototype as unknown as { requestFullscreen?: unknown }).requestFullscreen;
    }
  });
});
