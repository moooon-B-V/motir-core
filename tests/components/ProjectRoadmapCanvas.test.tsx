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
    expect(within(legend).getByText('blocked elsewhere')).toBeTruthy();
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

  // LOCATE control (MOTIR-1421) — opt-in via `locatable`. The located node lights up
  // via the same `data-highlighted` treatment the search-locate uses, so the test
  // asserts which node carries it.
  function hl(id: string) {
    return el(id)!.querySelector('[data-highlighted]');
  }
  function sel(id: string) {
    return el(id)!.querySelector('[data-selected]');
  }

  it('does not offer the locate control by default', async () => {
    render(<ProjectRoadmapCanvas loadLevel={loadLevel} />);
    await screen.findByText('Epic one');
    expect(screen.queryByTestId('locate-button')).toBeNull();
  });

  it('locates the "you are here" frontier first — single target, no cycling hint', async () => {
    const level: RoadmapLevel = {
      nodes: [
        { ...node('A', 'a'), here: true },
        { ...node('B', 'b'), ready: true },
      ],
      deps: [],
    };
    render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(level)} locatable />);
    await screen.findByText('a');
    const btn = screen.getByTestId('locate-button');
    expect(btn.getAttribute('aria-label')).toBe('Locate the current item');
    fireEvent.click(btn);
    expect(hl('A')).toBeTruthy(); // the frontier is centred, not the ready node
    expect(hl('B')).toBeNull();
    expect(sel('A')).toBeTruthy(); // ...and SELECTED, so its actions surface
    expect(sel('B')).toBeNull();
    expect(screen.queryByTestId('locate-hint')).toBeNull();
  });

  it('cycles the ready nodes with wrap when there is no frontier, showing the n/m hint', async () => {
    const level: RoadmapLevel = {
      nodes: [
        { ...node('R1', 'r1'), ready: true },
        { ...node('R2', 'r2'), ready: true },
        { ...node('R3', 'r3'), ready: true },
      ],
      deps: [],
    };
    render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(level)} locatable />);
    await screen.findByText('r1');
    const btn = screen.getByTestId('locate-button');
    expect(btn.getAttribute('aria-label')).toBe('Locate the next ready item');
    fireEvent.click(btn); // → R1
    expect(hl('R1')).toBeTruthy();
    expect(screen.getByTestId('locate-hint').textContent).toBe('1 / 3');
    fireEvent.click(btn); // → R2
    expect(hl('R2')).toBeTruthy();
    expect(hl('R1')).toBeNull();
    expect(sel('R2')).toBeTruthy(); // selection follows the cycle
    expect(sel('R1')).toBeNull();
    expect(screen.getByTestId('locate-hint').textContent).toBe('2 / 3');
    fireEvent.click(btn); // → R3
    expect(screen.getByTestId('locate-hint').textContent).toBe('3 / 3');
    fireEvent.click(btn); // wrap → R1
    expect(hl('R1')).toBeTruthy();
    expect(screen.getByTestId('locate-hint').textContent).toBe('1 / 3');
  });

  it('a single ready node locates with no cycling hint', async () => {
    const level: RoadmapLevel = {
      nodes: [{ ...node('R', 'r'), ready: true }, node('X', 'x')],
      deps: [],
    };
    render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(level)} locatable />);
    await screen.findByText('r');
    const btn = screen.getByTestId('locate-button');
    expect(btn.getAttribute('aria-label')).toBe('Locate the ready item');
    fireEvent.click(btn);
    expect(hl('R')).toBeTruthy();
    expect(screen.queryByTestId('locate-hint')).toBeNull();
  });

  it('disables locate when nothing is actionable (no frontier, no ready)', async () => {
    const level: RoadmapLevel = { nodes: [node('A', 'a'), node('B', 'b')], deps: [] };
    render(<ProjectRoadmapCanvas loadLevel={() => Promise.resolve(level)} locatable />);
    await screen.findByText('a');
    expect(screen.getByTestId('locate-button').hasAttribute('disabled')).toBe(true);
  });

  it('resets the cycle cursor when the level’s ready set changes', async () => {
    let lvl: RoadmapLevel = {
      nodes: [
        { ...node('R1', 'r1'), ready: true },
        { ...node('R2', 'r2'), ready: true },
      ],
      deps: [],
    };
    const load = () => Promise.resolve(lvl);
    const { rerender } = render(<ProjectRoadmapCanvas loadLevel={load} locatable reloadKey="1" />);
    await screen.findByText('r1');
    const btn = screen.getByTestId('locate-button');
    fireEvent.click(btn);
    fireEvent.click(btn); // → 2 / 2
    expect(screen.getByTestId('locate-hint').textContent).toBe('2 / 2');
    // the level's ready set changes (a drill / re-plan) → bump reloadKey to refetch
    lvl = {
      nodes: [
        { ...node('R3', 'r3'), ready: true },
        { ...node('R4', 'r4'), ready: true },
        { ...node('R5', 'r5'), ready: true },
      ],
      deps: [],
    };
    rerender(<ProjectRoadmapCanvas loadLevel={load} locatable reloadKey="2" />);
    await screen.findByText('r3');
    // cursor reset: the first click lands on the FIRST ready of the new set
    fireEvent.click(btn);
    expect(hl('R3')).toBeTruthy();
    expect(screen.getByTestId('locate-hint').textContent).toBe('1 / 3');
  });
});
