// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import {
  ProjectRoadmapCanvas,
  type RoadmapLevel,
} from '@/components/planning/ProjectRoadmapCanvas';
import type { ProjectCanvasNode } from '@/lib/planning/projectCanvasModel';

// MOTIR-3261 — SHOW CHANGES: one control lights every card the plan touches on
// the level in view and pushes the rest back. Built to
// `design/ai-planning/design-notes.md` Part IX §L and
// `plan-canvas-arrival.mock.html` panels 3–4.
//
// ⚠️ THE TREATMENT IS NOT NEW AND MUST NOT BE. `ProjectRoadmapCanvas`'s node
// wrapper already rings a selected or search-matched node
// (`ring-2 ring-(--el-accent) ring-offset-2 ring-offset-(--el-surface-soft)`) and
// already dims everything outside the connected set (`opacity-35`). This applies
// THAT PAIR to a SET — one ring value, one dim value, one vocabulary — so the
// assertions below are on the shipped class strings, and a second dim or a second
// ring fails them even if it looks right on screen.

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

// A busy committed level with three of the plan's cards on it, plus a level below
// that the plan does not reach at all.
const levels: Record<string, RoadmapLevel> = {
  __root__: {
    nodes: [
      node('P1', 'A proposal'),
      node('C1', 'A committed sibling', true),
      node('P2', 'A modified card'),
      node('C2', 'Another sibling'),
      node('P3', 'An archived card'),
    ],
    deps: [],
  },
  C1: { nodes: [node('X1', 'Nothing proposed here'), node('X2', 'Nor here')], deps: [] },
};
const loadLevel = (parentId: string | null): Promise<RoadmapLevel> =>
  Promise.resolve(levels[parentId ?? '__root__'] ?? { nodes: [], deps: [] });

const el = (id: string) => document.querySelector(`[data-node-id="${id}"]`);
/** The wrapper `renderNode` puts the ring and the dim on — a CHILD of the
 *  positioned `[data-node-id]` box the canvas engine owns. */
const box = (id: string) => el(id)!.querySelector(':scope > div')!;
const toggle = () => screen.getByTestId('show-changes-toggle');

const EMPHASIS = {
  ids: ['P1', 'P2', 'P3'],
  total: 3,
  label: 'Show changes',
  emptyLabel: 'No proposed changes on this level',
};

const renderCanvas = (emphasis: typeof EMPHASIS | null = EMPHASIS) =>
  render(
    <ProjectRoadmapCanvas
      loadLevel={loadLevel}
      rootLabel="Roadmap"
      {...(emphasis ? { emphasis } : {})}
    />,
  );

describe('the prop is OPT-IN (MOTIR-3261)', () => {
  it('a canvas with no `emphasis` renders no toggle at all', async () => {
    // The four other consumers — `OnboardingCanvas`, `PlanChangeCanvas`,
    // `WorkItemRoadmap`, `RoadmapView` — mount this component without the prop,
    // so this is what keeps them byte-unchanged. An onboarding canvas that grew a
    // Show-changes toggle would be a regression.
    renderCanvas(null);

    await screen.findByText('A proposal');
    expect(screen.queryByTestId('show-changes-toggle')).toBeNull();
  });
});

describe('the emphasis (MOTIR-3261)', () => {
  it('lights EVERY id on the level and dims the rest, with the SHIPPED classes', async () => {
    renderCanvas();
    await screen.findByText('A proposal');

    fireEvent.click(toggle());

    for (const id of ['P1', 'P2', 'P3']) {
      const cls = box(id).className;
      expect(cls).toContain('ring-2 ring-(--el-accent)');
      expect(cls).not.toContain('opacity-35');
      expect(box(id).getAttribute('data-emphasised')).toBe('true');
    }
    for (const id of ['C1', 'C2']) {
      const cls = box(id).className;
      expect(cls).toContain('opacity-35');
      expect(cls).not.toContain('ring-2');
      expect(box(id).getAttribute('data-emphasised')).toBeNull();
    }
  });

  it('pressing it again restores the level exactly', async () => {
    renderCanvas();
    await screen.findByText('A proposal');

    fireEvent.click(toggle());
    fireEvent.click(toggle());

    for (const id of ['P1', 'P2', 'P3', 'C1', 'C2']) {
      const cls = box(id).className;
      expect(cls).not.toContain('opacity-35');
      expect(cls).not.toContain('ring-2');
    }
  });

  it('carries `aria-pressed` reflecting its state', async () => {
    renderCanvas();
    await screen.findByText('A proposal');

    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
  });

  it('honours reduced motion — the opacity transition is dropped', async () => {
    // Turning this on changes the opacity of most of the screen at once
    // (Part IX §L8).
    renderCanvas();
    await screen.findByText('A proposal');

    expect(box('P1').className).toContain('motion-reduce:transition-none');
  });
});

describe('a live SELECTION wins, and the toggle stays pressed (Part IX §L4)', () => {
  it('turn it ON, then SELECT — the selection decides the dimming', async () => {
    renderCanvas();
    await screen.findByText('A proposal');

    fireEvent.click(toggle());
    fireEvent.keyDown(el('C1')!, { key: 'Enter' });

    // The selected committed node is ringed and NOT dimmed; a proposal outside
    // its connected set is dimmed like any other unconnected node.
    expect(box('C1').className).toContain('ring-2');
    expect(box('C1').className).not.toContain('opacity-35');
    expect(box('P1').className).toContain('opacity-35');
    // …and the toggle is STILL pressed, so clearing the selection restores the
    // emphasis rather than making the reader re-arm it.
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
  });

  it('SELECT, then turn it on — the same state, in the other order', async () => {
    renderCanvas();
    await screen.findByText('A proposal');

    fireEvent.keyDown(el('C1')!, { key: 'Enter' });
    fireEvent.click(toggle());

    expect(box('C1').className).toContain('ring-2');
    expect(box('P1').className).toContain('opacity-35');
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
  });

  it('clearing the selection RESTORES the emphasis', async () => {
    renderCanvas();
    await screen.findByText('A proposal');

    fireEvent.click(toggle());
    fireEvent.keyDown(el('C1')!, { key: 'Enter' });
    expect(box('P1').className).toContain('opacity-35');

    // A press on empty canvas that does not pan clears the selection — the real
    // gesture, driven as the component listens for it (pointer down then up on
    // the viewport, with no movement between).
    const viewport = screen.getByTestId('planning-canvas');
    viewport.setPointerCapture = () => {};
    viewport.releasePointerCapture = () => {};
    fireEvent.pointerDown(viewport, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(viewport, { pointerId: 1, clientX: 10, clientY: 10 });

    // …and the emphasis comes back, because the toggle was never un-pressed.
    await waitFor(() => expect(box('P1').className).toContain('ring-2'));
    expect(box('C1').className).toContain('opacity-35');
  });
});

describe('the toggle RESETS on a level change (MOTIR-3261)', () => {
  it('drilling arrives un-emphasised', async () => {
    renderCanvas();
    await screen.findByText('A proposal');
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-pressed')).toBe('true');

    fireEvent.keyDown(el('C1')!, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('drill-button'));
    await screen.findByText('Nothing proposed here');

    // A stale emphasis must never survive a drill — the assertion is on the
    // RESET, so a later refactor of the level-change handler cannot drop it
    // silently.
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
  });

  it('and Back arrives un-emphasised too', async () => {
    renderCanvas();
    await screen.findByText('A proposal');
    fireEvent.keyDown(el('C1')!, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('drill-button'));
    await screen.findByText('Nothing proposed here');

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findByText('A proposal');

    expect(toggle().getAttribute('aria-pressed')).toBe('false');
  });
});

describe('the degenerate levels (Part IX §L6)', () => {
  it('a level with NO proposals DISABLES the toggle, with its reason', async () => {
    renderCanvas();
    await screen.findByText('A proposal');
    fireEvent.keyDown(el('C1')!, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('drill-button'));
    await screen.findByText('Nothing proposed here');

    // An ON state here would dim every card and ring none — a screen that says
    // nothing, which is worse than a control that says why it cannot help.
    expect(toggle().hasAttribute('disabled')).toBe(true);
    expect(toggle().getAttribute('title')).toBe('No proposed changes on this level');
  });

  it('a level that is ENTIRELY the plan’s rings everything and dims nothing', async () => {
    render(
      <ProjectRoadmapCanvas
        loadLevel={loadLevel}
        rootLabel="Roadmap"
        emphasis={{ ...EMPHASIS, ids: ['P1', 'C1', 'P2', 'C2', 'P3'], total: 5 }}
      />,
    );
    await screen.findByText('A proposal');

    fireEvent.click(toggle());

    for (const id of ['P1', 'C1', 'P2', 'C2', 'P3']) {
      expect(box(id).className).toContain('ring-2');
      expect(box(id).className).not.toContain('opacity-35');
    }
  });
});

describe('the OFF-LEVEL count (Part IX §L5)', () => {
  it('reads `n/m` when the level holds fewer than the whole plan', async () => {
    render(
      <ProjectRoadmapCanvas
        loadLevel={loadLevel}
        rootLabel="Roadmap"
        emphasis={{ ...EMPHASIS, total: 11 }}
      />,
    );
    await screen.findByText('A proposal');

    // The canvas is per-level and most of a spread plan is off-screen. The
    // control says so and offers no way to reach the rest — that is the list
    // view's job.
    expect(within(toggle()).getByText('3/11')).toBeTruthy();
  });

  it('shows NO count when the level holds all of them', async () => {
    renderCanvas();
    await screen.findByText('A proposal');

    expect(within(toggle()).queryByText(/\//)).toBeNull();
  });
});
