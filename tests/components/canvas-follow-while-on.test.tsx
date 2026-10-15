// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import {
  ProjectRoadmapCanvas,
  type ProjectRoadmapCanvasProps,
  type RoadmapLevel,
} from '@/components/planning/ProjectRoadmapCanvas';
import { PlanReviewCanvas } from '@/components/planning/PlanReviewCanvas';
import type { CanvasCrumb, ProjectCanvasNode } from '@/lib/planning/projectCanvasModel';
import type { LiveArrival } from '@/lib/planning/livePane';
import { planReviewItem } from '../helpers/planReview';

// THE CANVAS FOLLOWS WHILE ASKED (MOTIR-8593, Story MOTIR-8590). `followMode:
// 'whileOn'` honours every NEW key, and `onReaderNavigated` reports the moves the
// PERSON made, apart from the canvas's own. The default `'once'` mode is ruled on
// by `ProjectRoadmapCanvas.test.tsx`'s `followTo` block, unchanged.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

// root → [E1 (drillable), E2]; E1 → [S1, S2]; S1 → [T1, T2];
// E2 → [ONLY (drillable)] — a single-parent level auto-descend would compact;
// ONLY → [L1].
const levels: Record<string, RoadmapLevel> = {
  __root__: { nodes: [node('E1', 'Epic one', true), node('E2', 'Epic two')], deps: [] },
  E1: { nodes: [node('S1', 'Story one'), node('S2', 'Story two')], deps: [] },
  S1: { nodes: [node('T1', 'Subtask one'), node('T2', 'Subtask two')], deps: [] },
  E2: { nodes: [node('ONLY', 'Only story', true)], deps: [] },
  ONLY: { nodes: [node('L1', 'Leaf one')], deps: [] },
  E1b: { nodes: [node('S1', 'Story one'), node('S2', 'Story two')], deps: [] },
};
const loadLevel = (parentId: string | null): Promise<RoadmapLevel> =>
  Promise.resolve(levels[parentId ?? '__root__'] ?? { nodes: [], deps: [] });

const el = (id: string) => document.querySelector(`[data-node-id="${id}"]`);
const crumbs = () =>
  within(screen.getByRole('navigation', { name: 'Breadcrumb' }))
    .getAllByRole('listitem')
    .map((li) => li.textContent);

const E1: CanvasCrumb[] = [{ id: 'E1', label: 'MOTIR-1 · Epic one' }];
const S1: CanvasCrumb[] = [...E1, { id: 'S1', label: 'MOTIR-2 · Story one' }];
const E2: CanvasCrumb[] = [{ id: 'E2', label: 'MOTIR-3 · Epic two' }];

function Canvas(p: Partial<ProjectRoadmapCanvasProps>) {
  return <ProjectRoadmapCanvas loadLevel={loadLevel} rootLabel="Roadmap" {...p} />;
}

describe("followMode: 'whileOn'", () => {
  it('moves on EVERY new key, naming each level and announcing it', async () => {
    const view = render(<Canvas followMode="whileOn" />);
    await screen.findByText('Epic one');

    view.rerender(<Canvas followMode="whileOn" followTo={{ key: 'k1', trail: E1 }} />);
    expect(await screen.findByText('Story one')).toBeTruthy();
    expect(crumbs().join('|')).toContain('MOTIR-1');
    expect(screen.getByTestId('canvas-follow-live').textContent).toContain('MOTIR-1 · Epic one');

    view.rerender(<Canvas followMode="whileOn" followTo={{ key: 'k2', trail: S1 }} />);
    expect(await screen.findByText('Subtask one')).toBeTruthy();
    expect(crumbs().join('|')).toContain('MOTIR-2');
    expect(screen.getByTestId('canvas-follow-live').textContent).toContain('MOTIR-2 · Story one');

    view.rerender(<Canvas followMode="whileOn" followTo={{ key: 'k3', trail: E2 }} />);
    expect(await screen.findByText('Only story')).toBeTruthy();
    expect(crumbs().join('|')).toContain('MOTIR-3');
    expect(screen.getByTestId('canvas-follow-live').textContent).toContain('MOTIR-3 · Epic two');
  });

  it('a repeat key, or a new key on the level in view, neither moves nor announces', async () => {
    const onLevelChange = vi.fn();
    const view = render(
      <Canvas
        followMode="whileOn"
        initialTrail={E1}
        onLevelChange={onLevelChange}
        followTo={{ key: 'same', trail: E1 }}
      />,
    );
    await screen.findByText('Story one');
    await act(async () => {});
    expect(screen.getByTestId('canvas-follow-live').textContent).toBe('');

    view.rerender(
      <Canvas
        followMode="whileOn"
        initialTrail={E1}
        onLevelChange={onLevelChange}
        followTo={{ key: 'same', trail: E1 }}
      />,
    );
    view.rerender(
      <Canvas
        followMode="whileOn"
        initialTrail={E1}
        onLevelChange={onLevelChange}
        followTo={{ key: 'next-same-level', trail: E1 }}
      />,
    );
    await act(async () => {});
    expect(screen.getByText('Story one')).toBeTruthy();
    expect(screen.getByTestId('canvas-follow-live').textContent).toBe('');
    expect(onLevelChange).not.toHaveBeenCalled();
  });

  it('is never declined — after a crumb, a drill, Back or a seeded navigation', async () => {
    const onFollowDeclined = vi.fn();
    const props = { followMode: 'whileOn' as const, onFollowDeclined, readerHasNavigated: true };
    const view = render(<Canvas {...props} />);
    await screen.findByText('Epic one');

    // seeded readerHasNavigated → still granted
    view.rerender(<Canvas {...props} followTo={{ key: 'a', trail: S1 }} />);
    expect(await screen.findByText('Subtask one')).toBeTruthy();

    // a crumb click, then a new key
    fireEvent.click(screen.getByRole('button', { name: 'Roadmap' }));
    await screen.findByText('Epic one');
    view.rerender(<Canvas {...props} followTo={{ key: 'b', trail: E1 }} />);
    expect(await screen.findByText('Story one')).toBeTruthy();

    // Back, then a new key
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findByText('Epic one');
    view.rerender(<Canvas {...props} followTo={{ key: 'c', trail: S1 }} />);
    expect(await screen.findByText('Subtask one')).toBeTruthy();

    // a drill, then a new key
    fireEvent.click(screen.getByRole('button', { name: 'Roadmap' }));
    await screen.findByText('Epic one');
    fireEvent.keyDown(el('E1')!, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('drill-button'));
    await screen.findByText('Story one');
    view.rerender(<Canvas {...props} followTo={{ key: 'd', trail: E2 }} />);
    expect(await screen.findByText('Only story')).toBeTruthy();

    expect(onFollowDeclined).not.toHaveBeenCalled();
    expect(screen.queryByTestId('canvas-follow-offer')).toBeNull();
  });

  it('a grant reports the followed trail through onLevelChange; "once" does not', async () => {
    const whileOn = vi.fn();
    const view = render(<Canvas followMode="whileOn" onLevelChange={whileOn} />);
    await screen.findByText('Epic one');
    view.rerender(
      <Canvas followMode="whileOn" onLevelChange={whileOn} followTo={{ key: 'k', trail: S1 }} />,
    );
    await screen.findByText('Subtask one');
    await act(async () => {});
    expect(whileOn).toHaveBeenCalledTimes(1);
    expect(whileOn).toHaveBeenCalledWith(S1);
    cleanup();

    const once = vi.fn();
    const v2 = render(<Canvas onLevelChange={once} />);
    await screen.findByText('Epic one');
    v2.rerender(<Canvas onLevelChange={once} followTo={{ key: 'k', trail: S1 }} />);
    await screen.findByText('Subtask one');
    await act(async () => {});
    expect(once).not.toHaveBeenCalled();
  });

  it('does not auto-descend past a followed single-parent level', async () => {
    const view = render(<Canvas followMode="whileOn" autoDescendSingleParent />);
    await screen.findByText('Epic one');
    view.rerender(
      <Canvas followMode="whileOn" autoDescendSingleParent followTo={{ key: 'k', trail: E2 }} />,
    );
    expect(await screen.findByText('Only story')).toBeTruthy();
    await act(async () => {});
    expect(el('L1')).toBeNull();
  });

  it('carries the reduced-motion escape on the level a grant fades', async () => {
    const view = render(<Canvas followMode="whileOn" />);
    await screen.findByText('Epic one');
    view.rerender(<Canvas followMode="whileOn" followTo={{ key: 'k', trail: E1 }} />);
    await screen.findByText('Story one');
    const canvas = screen.getByTestId('planning-canvas').parentElement!;
    expect(canvas.className).toContain('motion-reduce:transition-none');
    expect(canvas.className).toContain('transition-opacity');
  });
});

describe('onReaderNavigated — the person, never the canvas', () => {
  for (const mode of ['once', 'whileOn'] as const) {
    it(`reports a crumb, the root crumb, Back and Open (${mode})`, async () => {
      const nav = vi.fn();
      render(<Canvas followMode={mode} initialTrail={S1} onReaderNavigated={nav} />);
      await screen.findByText('Subtask one');

      fireEvent.click(screen.getByRole('button', { name: 'MOTIR-1 · Epic one' }));
      await screen.findByText('Story one');
      expect(nav.mock.calls).toEqual([['crumb']]);

      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      await screen.findByText('Epic one');
      expect(nav.mock.calls).toEqual([['crumb'], ['back']]);

      fireEvent.keyDown(el('E1')!, { key: 'Enter' });
      fireEvent.click(await screen.findByTestId('drill-button'));
      await screen.findByText('Story one');
      expect(nav.mock.calls).toEqual([['crumb'], ['back'], ['drill']]);

      fireEvent.click(screen.getByRole('button', { name: 'Roadmap' }));
      await screen.findByText('Epic one');
      expect(nav.mock.calls).toEqual([['crumb'], ['back'], ['drill'], ['crumb']]);
    });
  }

  it('reports a search-to-locate submit that finds a card', async () => {
    const nav = vi.fn();
    render(<Canvas searchable searchLabel="Search the roadmap" onReaderNavigated={nav} />);
    await screen.findByText('Epic one');
    const input = screen.getByPlaceholderText('Search the roadmap');
    fireEvent.change(input, { target: { value: 'Epic two' } });
    expect(nav).not.toHaveBeenCalled(); // typing is not a jump
    fireEvent.submit(input.closest('form')!);
    expect(nav.mock.calls).toEqual([['search']]);
  });

  it('reports taking the follow offer as a pick', async () => {
    const nav = vi.fn();
    const view = render(<Canvas initialTrail={E1} onReaderNavigated={nav} />);
    await screen.findByText('Story one');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findByText('Epic one');
    view.rerender(
      <Canvas initialTrail={E1} onReaderNavigated={nav} followTo={{ key: 'k', trail: S1 }} />,
    );
    fireEvent.click(await screen.findByTestId('canvas-follow-offer'));
    expect(await screen.findByText('Subtask one')).toBeTruthy();
    expect(nav.mock.calls).toEqual([['back'], ['pick']]);
  });

  it('reports the arrivals Go there as a pick', async () => {
    const nav = vi.fn();
    const arrival = (id: string): LiveArrival => ({
      id,
      levelId: 'S1',
      trail: S1,
      arrivesOnFirstSight: true,
    });
    const view = render(<Canvas arrivals={[]} onReaderNavigated={nav} />);
    await screen.findByText('Epic one');
    view.rerender(<Canvas arrivals={[arrival('p1')]} onReaderNavigated={nav} />);
    fireEvent.click(await screen.findByTestId('canvas-arrivals-offer'));
    expect(await screen.findByText('Subtask one')).toBeTruthy();
    expect(nav.mock.calls).toEqual([['pick']]);
  });

  it('one call for the Open that starts a chained auto-descent', async () => {
    const nav = vi.fn();
    const chain: Record<string, RoadmapLevel> = {
      __root__: { nodes: [node('P', 'Parent', true), node('Q', 'Other')], deps: [] },
      P: { nodes: [node('C', 'Child', true)], deps: [] },
      C: { nodes: [node('G', 'Grandchild')], deps: [] },
    };
    render(
      <ProjectRoadmapCanvas
        loadLevel={(id) => Promise.resolve(chain[id ?? '__root__'] ?? { nodes: [], deps: [] })}
        rootLabel="Roadmap"
        autoDescendSingleParent
        onReaderNavigated={nav}
      />,
    );
    await screen.findByText('Parent');
    fireEvent.keyDown(el('P')!, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('drill-button'));
    expect(await screen.findByText('Grandchild')).toBeTruthy();
    await act(async () => {});
    expect(nav.mock.calls).toEqual([['drill']]);
  });

  it('is silent for a grant, an adoption, a re-key, a card click, View and Locate', async () => {
    const nav = vi.fn();
    const onView = vi.fn();
    const viewable: RoadmapLevel = {
      nodes: [{ ...node('V', 'View me'), viewable: true, ready: true }],
      deps: [],
    };
    const levelsWithV = { ...levels, S2: viewable };
    const load = (id: string | null) =>
      Promise.resolve(levelsWithV[id ?? '__root__'] ?? { nodes: [], deps: [] });
    const base = { loadLevel: load, rootLabel: 'Roadmap', onReaderNavigated: nav } as const;

    // a followTo grant (both modes)
    const view = render(<ProjectRoadmapCanvas {...base} />);
    await screen.findByText('Epic one');
    view.rerender(<ProjectRoadmapCanvas {...base} followTo={{ key: 'k', trail: E1 }} />);
    await screen.findByText('Story one');
    view.rerender(
      <ProjectRoadmapCanvas {...base} followMode="whileOn" followTo={{ key: 'k2', trail: S1 }} />,
    );
    await screen.findByText('Subtask one');
    cleanup();

    // a controlledTrail adoption
    const v2 = render(<ProjectRoadmapCanvas {...base} controlledTrail={[]} />);
    await screen.findByText('Epic one');
    v2.rerender(<ProjectRoadmapCanvas {...base} controlledTrail={E1} />);
    await screen.findByText('Story one');
    cleanup();

    // a resolveHeldNode re-key
    const v3 = render(<ProjectRoadmapCanvas {...base} initialTrail={E1} />);
    await screen.findByText('Story one');
    v3.rerender(
      <ProjectRoadmapCanvas
        {...base}
        initialTrail={E1}
        resolveHeldNode={(id) => (id === 'E1' ? { id: 'E1b', label: 'MOTIR-1 · Epic one' } : null)}
      />,
    );
    await act(async () => {});
    cleanup();

    // a card click, View and the Locate control
    render(
      <ProjectRoadmapCanvas
        {...base}
        initialTrail={[...E1, { id: 'S2', label: 'S2' }]}
        onView={onView}
        locatable
      />,
    );
    await screen.findByText('View me');
    fireEvent.keyDown(el('V')!, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('view-button'));
    expect(onView).toHaveBeenCalledWith('V');
    fireEvent.click(screen.getByTestId('locate-button'));
    await act(async () => {});

    expect(nav).not.toHaveBeenCalled();
  });
});

describe('PlanReviewCanvas forwards the follow mode', () => {
  it("moves on two keys with followMode: 'whileOn'", async () => {
    const story = planReviewItem({
      planItemId: 'ps',
      nodeId: 'ps',
      title: 'Proposed story',
      kind: 'story',
    });
    const task = planReviewItem({
      planItemId: 'pt',
      nodeId: 'pt',
      parentNodeId: 'ps',
      title: 'Proposed task',
    });
    const sub = planReviewItem({
      planItemId: 'pu',
      nodeId: 'pu',
      parentNodeId: 'pt',
      title: 'Proposed subtask',
    });
    // The committed roadmap is empty at every level, so each level is its proposals.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ nodes: [], edges: [], offLevelBlockers: [] }),
        } as Response),
      ),
    );
    const props = {
      items: [story, task, sub],
      projectKey: 'MOTIR',
      version: 0,
      followMode: 'whileOn' as const,
    };
    const first = [{ id: 'ps', label: 'New · Proposed story' }];
    const view = render(<PlanReviewCanvas {...props} />);
    // It arrives on the deepest proposed level, where the subtask sits.
    await waitFor(() => expect(el('pu')).toBeTruthy());
    view.rerender(<PlanReviewCanvas {...props} followTo={{ key: 'a', trail: [] }} />);
    await waitFor(() => expect(el('ps')).toBeTruthy());
    expect(el('pu')).toBeNull();
    view.rerender(<PlanReviewCanvas {...props} followTo={{ key: 'b', trail: first }} />);
    await waitFor(() => expect(el('pt')).toBeTruthy());
    expect(el('ps')).toBeNull();
  });
});
