// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
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

// Asserting a mock in this file: an EVENT-HANDLER callback (`onSelect`, `onView`,
// the "Reset layout" click → `onResetPositions`, `requestFullscreen`) is invoked
// SYNCHRONOUSLY inside the dispatched handler, so a plain `expect(mock)` right
// after `fireEvent` is deterministic and needs no wait. An EFFECT-driven callback
// (the auto-reset below) is NOT — it must be awaited via `waitFor`. See the note
// on that test.
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

  // `onResetPositions` is fired from the AUTO-RESET *passive effect*, not from the
  // render — so a rendered node is the WRONG signal to assert it on. React flushes
  // passive effects on a scheduler callback AFTER commit, and RTL's async wrapper
  // turns the act environment OFF for `findBy*` and drains with a bare
  // `setTimeout(0)`; under CI load that macrotask can win the race against the
  // scheduler, so `findByText('c')` resolves with the effect still pending and a
  // plain `expect(mock)` samples 0 calls. Wait on the callback itself — the
  // authoritative signal (CLAUDE.md § E2E tests wait on the AUTHORITATIVE signal /
  // notes.html #37, at the component altitude). This is MOTIR-1736.
  it('auto-resets a level when its auto-laid node set changes (a re-plan)', async () => {
    const onResetPositions = vi.fn();
    let levelNodes = [node('A', 'a'), node('B', 'b')];
    const load = () => Promise.resolve({ nodes: levelNodes, deps: [] });
    const { rerender } = render(
      <ProjectRoadmapCanvas loadLevel={load} onResetPositions={onResetPositions} reloadKey="1" />,
    );
    await screen.findByText('a');
    // Flush the pending effect pass BEFORE the negative assertion — otherwise it
    // races the same way and would pass vacuously (green even if the component
    // wrongly reset on first load).
    await act(async () => {});
    expect(onResetPositions).not.toHaveBeenCalled(); // first render: no prior signature
    // the level's items change → bump reloadKey to refetch
    levelNodes = [node('A', 'a'), node('C', 'c')];
    rerender(
      <ProjectRoadmapCanvas loadLevel={load} onResetPositions={onResetPositions} reloadKey="2" />,
    );
    await screen.findByText('c');
    await waitFor(() =>
      expect(onResetPositions).toHaveBeenCalledWith(expect.arrayContaining(['A', 'C'])),
    );
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

  // ── AUTO-DESCEND a single-drillable-parent level (MOTIR-1807) ───────────────────
  // Design: `design/roadmap/auto-drill.mock.html` + its `design-notes.md` section
  // (MOTIR-1805). A level that resolves to exactly ONE drillable node offers no
  // choice, so the canvas descends into it and the roadmap opens on the WORK rather
  // than on one card. The prop is OFF by default because this canvas is the shared
  // foundation behind five consumers.
  describe('autoDescendSingleParent', () => {
    // A two-level chain: root → [P] → [C] → [L1, L2] — it compacts in ONE arrival and
    // stops where the plan actually branches (design panel D).
    const chain: Record<string, RoadmapLevel> = {
      __root__: { nodes: [node('P', 'Parent story', true)], deps: [] },
      P: { nodes: [node('C', 'Child story', true)], deps: [] },
      C: { nodes: [node('L1', 'Leaf one'), node('L2', 'Leaf two')], deps: [] },
    };
    // A single-level version: root → [P] → [S1, S2].
    const oneDeep: Record<string, RoadmapLevel> = {
      __root__: { nodes: [node('P', 'Parent story', true)], deps: [] },
      P: { nodes: [node('S1', 'Story one'), node('S2', 'Story two')], deps: [] },
    };
    const serve = (tree: Record<string, RoadmapLevel>) => (parentId: string | null) =>
      Promise.resolve(tree[parentId ?? '__root__'] ?? { nodes: [], deps: [] });

    const crumbNav = () => screen.getByRole('navigation', { name: 'Breadcrumb' });
    const noCrumbNav = () => screen.queryByRole('navigation', { name: 'Breadcrumb' });
    const crumbLabels = () =>
      within(crumbNav())
        .getAllByRole('listitem')
        .map((li) => li.textContent);

    // THE CONTROL. The prop defaults to `false`, so the four consumers that do not opt
    // in (OnboardingCanvas / PlanReviewCanvas / PlanChangeCanvas / PlanningWorkspaceHost)
    // are provably unaffected by this whole feature.
    it('is OFF by default — a single drillable node renders as itself, no descent', async () => {
      render(<ProjectRoadmapCanvas loadLevel={serve(chain)} />);
      expect(await screen.findByText('Parent story')).toBeTruthy();
      await act(async () => {}); // flush any pending load before the negatives
      expect(el('C')).toBeNull();
      expect(el('L1')).toBeNull();
      expect(noCrumbNav()).toBeNull();
    });

    it('ON: descends into the single drillable node and keeps it as the breadcrumb', async () => {
      render(
        <ProjectRoadmapCanvas
          loadLevel={serve(oneDeep)}
          autoDescendSingleParent
          rootLabel="Roadmap"
        />,
      );
      // We land on the CHILDREN; the skipped level itself is never rendered.
      expect(await screen.findByText('Story one')).toBeTruthy();
      expect(el('S2')).toBeTruthy();
      expect(el('P')).toBeNull();
      expect(crumbLabels()).toEqual(['Roadmap', 'P']);
    });

    it('ON: Back and the crumb both return to the skipped level', async () => {
      render(
        <ProjectRoadmapCanvas
          loadLevel={serve(oneDeep)}
          autoDescendSingleParent
          rootLabel="Roadmap"
        />,
      );
      await screen.findByText('Story one');
      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      expect(await screen.findByText('Parent story')).toBeTruthy();
      expect(noCrumbNav()).toBeNull(); // back at the root level

      cleanup();
      render(
        <ProjectRoadmapCanvas
          loadLevel={serve(oneDeep)}
          autoDescendSingleParent
          rootLabel="Roadmap"
        />,
      );
      await screen.findByText('Story one');
      fireEvent.click(within(crumbNav()).getByText('Roadmap'));
      expect(await screen.findByText('Parent story')).toBeTruthy();
      expect(noCrumbNav()).toBeNull();
    });

    it('ON: CHAINS — two nested single-parent levels compact in one arrival, crumbs in descent order', async () => {
      render(
        <ProjectRoadmapCanvas
          loadLevel={serve(chain)}
          autoDescendSingleParent
          rootLabel="Roadmap"
        />,
      );
      expect(await screen.findByText('Leaf one')).toBeTruthy();
      expect(el('L2')).toBeTruthy();
      // Neither skipped ancestor was ever painted — the arrival reads as ONE landing.
      expect(el('P')).toBeNull();
      expect(el('C')).toBeNull();
      expect(screen.queryByText('Parent story')).toBeNull();
      expect(crumbLabels()).toEqual(['Roadmap', 'P', 'C']);
    });

    // The negative cases, drawn in design panel E so this card cannot guess them.
    it('does NOT descend when the level has ≥2 nodes (the choice is the user’s)', async () => {
      render(<ProjectRoadmapCanvas loadLevel={loadLevel} autoDescendSingleParent />);
      expect(await screen.findByText('Epic one')).toBeTruthy();
      await act(async () => {});
      expect(el('E2')).toBeTruthy();
      expect(el('S1')).toBeNull();
      expect(noCrumbNav()).toBeNull();
    });

    // MOTIR-1824 — the ONBOARDED-project shape. `buildWorkItemLevel` pins the
    // planning-origin cluster onto the ROOT level of a project that onboarded, as a
    // `decorative` node. It is provenance drawn beside the road, never a branch in
    // it, so it must not answer the "does this level offer a choice?" question. It
    // did, and the whole feature silently never fired for an onboarded project.
    const origin = (): ProjectCanvasNode => ({
      ...node('ORIGIN', 'Planning origin'),
      decorative: true,
    });

    it('DESCENDS past a decorative node — [origin + one drillable story] is still one choice', async () => {
      const onboarded: Record<string, RoadmapLevel> = {
        __root__: { nodes: [origin(), node('P', 'Parent story', true)], deps: [] },
        P: { nodes: [node('S1', 'Story one'), node('S2', 'Story two')], deps: [] },
      };
      render(
        <ProjectRoadmapCanvas
          loadLevel={serve(onboarded)}
          autoDescendSingleParent
          rootLabel="Roadmap"
        />,
      );
      expect(await screen.findByText('Story one')).toBeTruthy();
      expect(el('S2')).toBeTruthy();
      // Neither the skipped story NOR the cluster pinned beside it was painted —
      // the arrival is the same one a never-onboarded project gets.
      expect(el('P')).toBeNull();
      expect(el('ORIGIN')).toBeNull();
      expect(crumbLabels()).toEqual(['Roadmap', 'P']);
    });

    it('does NOT descend when a decorative node sits beside TWO stories (a real branch)', async () => {
      const twoStories: RoadmapLevel = {
        nodes: [origin(), node('P', 'Parent story', true), node('Q', 'Other story', true)],
        deps: [],
      };
      render(
        <ProjectRoadmapCanvas
          loadLevel={() => Promise.resolve(twoStories)}
          autoDescendSingleParent
        />,
      );
      expect(await screen.findByText('Parent story')).toBeTruthy();
      await act(async () => {});
      expect(el('Q')).toBeTruthy();
      expect(el('ORIGIN')).toBeTruthy(); // decoration still RENDERS; it is only uncounted
      expect(noCrumbNav()).toBeNull();
    });

    // The counting rule is "not decorative", NOT "drillable" — a level holding one
    // drillable story AND a childless bug offers a real choice (open the story, or
    // read the bug), and skipping it would hide the bug behind a card the user never
    // saw. This is the shape the narrower "count only drillable nodes" fix breaks.
    it('does NOT descend when the only drillable node shares the level with a LEAF', async () => {
      const storyAndLoose: RoadmapLevel = {
        nodes: [origin(), node('P', 'Parent story', true), node('B', 'Loose bug')],
        deps: [],
      };
      render(
        <ProjectRoadmapCanvas
          loadLevel={() => Promise.resolve(storyAndLoose)}
          autoDescendSingleParent
        />,
      );
      expect(await screen.findByText('Loose bug')).toBeTruthy();
      await act(async () => {});
      expect(el('P')).toBeTruthy();
      expect(noCrumbNav()).toBeNull();
    });

    it('does NOT descend when the single node is NOT drillable (a childless leaf)', async () => {
      const lone: RoadmapLevel = { nodes: [node('A', 'Lonely leaf')], deps: [] };
      render(
        <ProjectRoadmapCanvas loadLevel={() => Promise.resolve(lone)} autoDescendSingleParent />,
      );
      expect(await screen.findByText('Lonely leaf')).toBeTruthy();
      await act(async () => {});
      expect(noCrumbNav()).toBeNull();
    });

    it('does NOT descend when the level is empty', async () => {
      render(
        <ProjectRoadmapCanvas
          loadLevel={() => Promise.resolve({ nodes: [], deps: [] })}
          autoDescendSingleParent
        />,
      );
      expect(await screen.findByText('Nothing on the roadmap yet')).toBeTruthy();
      expect(noCrumbNav()).toBeNull();
    });

    // Design panel F: after an explicit climb the level SITS STILL — including across a
    // manual refresh, which re-runs the load for the CURRENT level (MOTIR-1542) and
    // must not lose the user's place. `loadLevel` is spied so the refresh assertion
    // waits on the REFETCH ACTUALLY HAVING HAPPENED, not on a timer — otherwise the
    // "still at the root" assertion would pass vacuously.
    it('SUPPRESSES the re-descend after the user climbs back — across a refresh too — until an explicit drill', async () => {
      const load = vi.fn(serve(oneDeep));
      const { rerender } = render(
        <ProjectRoadmapCanvas
          loadLevel={load}
          autoDescendSingleParent
          rootLabel="Roadmap"
          reloadKey="1"
        />,
      );
      await screen.findByText('Story one'); // arrived already drilled
      await waitFor(() => expect(load).toHaveBeenCalledTimes(2)); // root + the descent

      fireEvent.click(within(crumbNav()).getByText('Roadmap'));
      expect(await screen.findByText('Parent story')).toBeTruthy();
      await waitFor(() => expect(load).toHaveBeenCalledTimes(3)); // the root reload
      expect(noCrumbNav()).toBeNull();

      // A MANUAL REFRESH (a `reloadKey` bump) re-reads THIS level and stays put.
      rerender(
        <ProjectRoadmapCanvas
          loadLevel={load}
          autoDescendSingleParent
          rootLabel="Roadmap"
          reloadKey="2"
        />,
      );
      await waitFor(() => expect(load).toHaveBeenCalledTimes(4));
      await act(async () => {});
      expect(el('P')).toBeTruthy();
      expect(el('S1')).toBeNull();
      expect(noCrumbNav()).toBeNull();

      // An EXPLICIT drill re-arms the behaviour.
      fireEvent.keyDown(el('P')!, { key: 'Enter' });
      fireEvent.click(await screen.findByTestId('drill-button'));
      expect(await screen.findByText('Story one')).toBeTruthy();
      expect(crumbLabels()).toEqual(['Roadmap', 'P']);
    });

    // Design panel C: the two routes in are the same state. Both go through the ONE
    // `applyDrill` transition, so a hand drill and an arrival are indistinguishable.
    it('produces the SAME state as a hand-drilled view (identical crumbs + level)', async () => {
      // Route 1 — the user drills P by hand (prop off).
      render(<ProjectRoadmapCanvas loadLevel={serve(oneDeep)} rootLabel="Roadmap" />);
      await screen.findByText('Parent story');
      fireEvent.keyDown(el('P')!, { key: 'Enter' });
      fireEvent.click(await screen.findByTestId('drill-button'));
      await screen.findByText('Story one');
      const manualCrumbs = crumbLabels();
      const manualNodes = [...document.querySelectorAll('[data-node-id]')].map(
        (n) => (n as HTMLElement).dataset.nodeId,
      );
      cleanup();

      // Route 2 — the canvas arrives already drilled.
      render(
        <ProjectRoadmapCanvas
          loadLevel={serve(oneDeep)}
          autoDescendSingleParent
          rootLabel="Roadmap"
        />,
      );
      await screen.findByText('Story one');
      expect(crumbLabels()).toEqual(manualCrumbs);
      expect(
        [...document.querySelectorAll('[data-node-id]')].map(
          (n) => (n as HTMLElement).dataset.nodeId,
        ),
      ).toEqual(manualNodes);
    });

    it('clears the selection and the highlight when it descends', async () => {
      // Start on a level with a real choice, select + highlight a node, then let the
      // data change under a refresh so the level now resolves to ONE drillable node.
      let root: RoadmapLevel = { nodes: [node('A', 'Alpha'), node('B', 'Bravo')], deps: [] };
      const load = vi.fn((parentId: string | null) =>
        Promise.resolve(parentId === null ? root : (oneDeep.P as RoadmapLevel)),
      );
      const { rerender } = render(
        <ProjectRoadmapCanvas
          loadLevel={load}
          autoDescendSingleParent
          searchable
          rootLabel="Roadmap"
          reloadKey="1"
        />,
      );
      await screen.findByText('Alpha');
      fireEvent.keyDown(el('A')!, { key: 'Enter' }); // select
      fireEvent.change(screen.getByPlaceholderText('Search the roadmap'), {
        target: { value: 'Alpha' },
      });
      fireEvent.submit(screen.getByRole('search')); // highlight
      expect(el('A')!.querySelector('[data-selected]')).toBeTruthy();
      expect(el('A')!.querySelector('[data-highlighted]')).toBeTruthy();

      root = { nodes: [node('P', 'Parent story', true)], deps: [] };
      rerender(
        <ProjectRoadmapCanvas
          loadLevel={load}
          autoDescendSingleParent
          searchable
          rootLabel="Roadmap"
          reloadKey="2"
        />,
      );
      expect(await screen.findByText('Story one')).toBeTruthy();
      expect(document.querySelector('[data-selected]')).toBeNull();
      expect(document.querySelector('[data-highlighted]')).toBeNull();
      expect(crumbLabels()).toEqual(['Roadmap', 'P']);
    });
  });
});
