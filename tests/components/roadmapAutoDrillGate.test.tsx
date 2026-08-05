// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import {
  ProjectRoadmapCanvas,
  type RoadmapLevel,
} from '@/components/planning/ProjectRoadmapCanvas';
import { WorkItemRoadmap } from '@/components/planning/WorkItemRoadmap';
import type { ProjectCanvasNode } from '@/lib/planning/projectCanvasModel';

// STORY-LEVEL vitest GATE for MOTIR-1803 (roadmap auto-drill) — the coverage
// top-up + the assembled SEAM, run against the code card's MERGED surface
// (MOTIR-1807). Where `ProjectRoadmapCanvas.test.tsx` drives the descend
// behaviour with hand-built `RoadmapLevel` fixtures (the per-subtask floor), this
// suite covers what those fixtures cannot reach:
//
//   1. THE SEAM. The floor MOCKS the adapter away by handing the canvas nodes
//      that already carry `drillable`. Here the decision is driven end to end
//      from a REAL `fetchRoadmapLevel`-shaped wire payload through the REAL
//      `buildWorkItemLevel` — so `hasChildren` (DTO) → `drillable` (node) is
//      asserted as a contract, not assumed. A rename or a dropped field on
//      either side leaves both unit suites green and silently stops the descent.
//   2. THE RESIDUE BRANCHES. The descend predicate's cycle guard, the load
//      REJECTION path, and the navigation/full-screen arms the floor leaves
//      open — the ones between the shipped numbers and the ≥90% per-file gate
//      `vitest.config.ts` now holds these two files to.
//
// The opt-in BOUNDARY guard (only `WorkItemRoadmap` enables the prop) is the
// third leg of this gate and lives in `tests/planning/roadmapAutoDescendBoundary.test.ts` —
// it is a source-level invariant, not a render.
//
// No Postgres seam here, and that is correct: this story adds no route, service
// or repository code. The seam it ships is client-side (DTO → adapter → canvas).
//
// Assertion style matches the neighbouring suites: happy-dom, NO jest-dom
// matchers (plain vitest expectations), `renderWithIntl` for the real `en`
// catalog. An EFFECT-driven signal is awaited (`findBy*` / `waitFor`); a
// NEGATIVE assertion is preceded by an awaited empty `act` so it cannot pass
// vacuously before the effect pass lands (the CLAUDE.md component-test rule).

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function el(id: string) {
  return document.querySelector(`[data-node-id="${id}"]`);
}

const crumbNav = () => screen.getByRole('navigation', { name: 'Breadcrumb' });
const noCrumbNav = () => screen.queryByRole('navigation', { name: 'Breadcrumb' });
const crumbLabels = () =>
  within(crumbNav())
    .getAllByRole('listitem')
    .map((li) => li.textContent);

// ─────────────────────────── 1 · THE ADAPTER → CANVAS SEAM ───────────────────────────

describe('the adapter → canvas seam: hasChildren (DTO) reaches drillable (node)', () => {
  // One RAW wire row exactly as `GET /api/projects/[key]/roadmap` returns it —
  // the `RoadmapNode` shape `toItem` maps, NOT the already-adapted node the
  // canvas unit tests hand-build. Everything below this point in the stack is
  // the shipped code: `fetchRoadmapLevel` → `toItem` → `buildWorkItemLevel` →
  // `ProjectRoadmapCanvas`. Nothing is mocked but `fetch` itself.
  const wireNode = (
    id: string,
    identifier: string,
    title: string,
    hasChildren: boolean,
    parentId: string | null = null,
  ) => ({
    id,
    parentId,
    kind: 'story',
    identifier,
    title,
    status: 'todo',
    isDone: false,
    hasChildren,
  });

  /** Serve a per-level tree over the real endpoint shape; returns the fetch spy. */
  function serveWire(tree: Record<string, { nodes: unknown[]; edges: unknown[] }>) {
    const spy = vi.fn(async (url: string) => {
      const u = new URL(String(url), 'http://localhost');
      const parentId = u.searchParams.get('parentId') ?? '__root__';
      return { ok: true, json: async () => tree[parentId] ?? { nodes: [], edges: [] } };
    });
    vi.stubGlobal('fetch', spy);
    return spy;
  }

  it('descends on a level whose ONLY wire row says hasChildren: true, and fetches THAT id’s children', async () => {
    // The root wire level holds exactly one row, and the only thing that makes it
    // drillable is `hasChildren: true` on the DTO. If the adapter ever stops
    // carrying that field through, `drillable` is undefined, the predicate's
    // `only?.drillable === true` is false, and this test fails — which is the
    // whole point of driving it from the wire shape.
    const fetchSpy = serveWire({
      __root__: { nodes: [wireNode('E1', 'MOTIR-1', 'Lone epic', true)], edges: [] },
      E1: {
        nodes: [
          wireNode('S1', 'MOTIR-2', 'Story one', false, 'E1'),
          wireNode('S2', 'MOTIR-3', 'Story two', false, 'E1'),
        ],
        edges: [],
      },
    });

    render(<WorkItemRoadmap projectKey="MOTIR" />);

    // We land on the CHILDREN — the skipped level is never painted.
    expect(await screen.findByText('Story one')).toBeTruthy();
    expect(el('S2')).toBeTruthy();
    expect(el('E1')).toBeNull();

    // …and the descent asked the endpoint for THAT node's id, so the id the
    // adapter put on the node is the id the drill travelled on.
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    const urls = fetchSpy.mock.calls.map(([u]) => String(u));
    expect(urls[0]).toBe('/api/projects/MOTIR/roadmap');
    expect(urls[1]).toBe('/api/projects/MOTIR/roadmap?parentId=E1');
  });

  it('does NOT descend when the same wire row says hasChildren: false', async () => {
    // The CONTROL for the test above: the identical payload with one field
    // flipped. Together they prove the descent is decided BY that field and not
    // by node count alone — the assertion a per-unit fixture cannot make.
    serveWire({
      __root__: { nodes: [wireNode('E1', 'MOTIR-1', 'Lone epic', false)], edges: [] },
    });

    render(<WorkItemRoadmap projectKey="MOTIR" />);
    expect(await screen.findByText('Lone epic')).toBeTruthy();
    await act(async () => {}); // flush the effect pass before the negatives
    expect(noCrumbNav()).toBeNull();
  });

  // MOTIR-1824 — THE ONBOARDED PROJECT, end to end. The two tests above serve a
  // root level whose only node is the work item, which is only true of a project
  // that never onboarded. An ONBOARDED one gets the planning-origin cluster pinned
  // beside its roots by the SAME adapter call (`includeOrigin: parentId === null &&
  // showPlanningOrigin`), so its root level is never one node — and the feature
  // silently did nothing for it. The regression is only visible from here: both
  // canvas-level fixtures and a wire payload alone miss it, because the extra node
  // is injected BETWEEN them, by the adapter.
  it('descends on an ONBOARDED project, whose root level also carries the planning-origin cluster', async () => {
    const fetchSpy = serveWire({
      __root__: { nodes: [wireNode('E1', 'MOTIR-1', 'Lone epic', true)], edges: [] },
      E1: {
        nodes: [
          wireNode('S1', 'MOTIR-2', 'Story one', false, 'E1'),
          wireNode('S2', 'MOTIR-3', 'Story two', false, 'E1'),
        ],
        edges: [],
      },
    });

    render(<WorkItemRoadmap projectKey="MOTIR" showPlanningOrigin />);

    // Same arrival as the never-onboarded project: the work, not the lone card.
    expect(await screen.findByText('Story one')).toBeTruthy();
    expect(el('S2')).toBeTruthy();
    expect(el('E1')).toBeNull();
    expect(crumbLabels()).toEqual(['Roadmap', 'MOTIR-1 · Lone epic']);

    // TWO per-level ROADMAP reads (the root, then the level it descended into) —
    // counted over the roadmap URLs rather than the whole spy, because an ONBOARDED
    // project also fires the phase card's pre-plan read (MOTIR-2205), which is a
    // different endpoint and deliberately not on this path.
    const roadmapUrls = () =>
      fetchSpy.mock.calls.map(([u]) => String(u)).filter((u) => u.includes('/roadmap'));
    await waitFor(() => expect(roadmapUrls().length).toBe(2));
    expect(roadmapUrls()[1]).toBe('/api/projects/MOTIR/roadmap?parentId=E1');
  });

  it('an onboarded project with TWO root epics still renders its level — cluster and all', async () => {
    // The control for the test above, and the proof the fix did not degrade into
    // "descend whenever there is one drillable node": the same `showPlanningOrigin`
    // level with a real branch in it stays put, and the cluster is on screen (it
    // is excluded from the COUNT, not from the render).
    serveWire({
      __root__: {
        nodes: [
          wireNode('E1', 'MOTIR-1', 'Lone epic', true),
          wireNode('E2', 'MOTIR-9', 'Other epic', true),
        ],
        edges: [],
      },
    });

    render(<WorkItemRoadmap projectKey="MOTIR" showPlanningOrigin />);
    expect(await screen.findByText('Lone epic')).toBeTruthy();
    await act(async () => {}); // flush the effect pass before the negatives
    expect(el('E2')).toBeTruthy();
    expect(el('__planning_origin__')).toBeTruthy();
    expect(noCrumbNav()).toBeNull();
  });

  it('carries the adapter’s `identifier · title` crumb onto the auto-descended arrival', async () => {
    // The breadcrumb is the ONLY thing naming a level nobody clicked
    // (MOTIR-1805 DECISION 2), and its label is built by the ADAPTER from the
    // DTO's identifier + title — so the crumb is a second, independent read of
    // the same seam. A canvas-only fixture invents `crumbLabel` and proves
    // nothing about it.
    serveWire({
      __root__: { nodes: [wireNode('E1', 'MOTIR-1', 'Lone epic', true)], edges: [] },
      E1: {
        nodes: [
          wireNode('S1', 'MOTIR-2', 'Story one', false, 'E1'),
          wireNode('S2', 'MOTIR-3', 'Story two', false, 'E1'),
        ],
        edges: [],
      },
    });

    render(<WorkItemRoadmap projectKey="MOTIR" />);
    await screen.findByText('Story one');
    expect(crumbLabels()).toEqual(['Roadmap', 'MOTIR-1 · Lone epic']);
  });

  it('CHAINS through the real adapter: epic → story → leaves compacts in one arrival', async () => {
    // The chained descent, driven end to end from the wire. Each hop re-enters
    // `fetchRoadmapLevel` → `toItem` → `buildWorkItemLevel`, so this also proves
    // the seam holds on a DRILLED level, not just at the root (the level cache
    // is keyed per parent, and only the root is ever pre-warmed).
    const fetchSpy = serveWire({
      __root__: { nodes: [wireNode('E1', 'MOTIR-1', 'Lone epic', true)], edges: [] },
      E1: { nodes: [wireNode('S1', 'MOTIR-2', 'Lone story', true, 'E1')], edges: [] },
      S1: {
        nodes: [
          wireNode('T1', 'MOTIR-3', 'Task one', false, 'S1'),
          wireNode('T2', 'MOTIR-4', 'Task two', false, 'S1'),
        ],
        edges: [],
      },
    });

    render(<WorkItemRoadmap projectKey="MOTIR" />);
    expect(await screen.findByText('Task one')).toBeTruthy();
    expect(el('T2')).toBeTruthy();
    // Neither skipped ancestor was painted — one arrival, two crumbs.
    expect(el('E1')).toBeNull();
    expect(el('S1')).toBeNull();
    expect(crumbLabels()).toEqual(['Roadmap', 'MOTIR-1 · Lone epic', 'MOTIR-2 · Lone story']);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3));
  });

  it('a level with a real CHOICE is left alone, even when one row is drillable', async () => {
    // The seam must not over-fire: two rows means the user decides. Driven from
    // the wire so the "≥2 nodes" arm is asserted on adapter output too.
    serveWire({
      __root__: {
        nodes: [
          wireNode('E1', 'MOTIR-1', 'Epic one', true),
          wireNode('E2', 'MOTIR-2', 'Epic two', false),
        ],
        edges: [],
      },
    });

    render(<WorkItemRoadmap projectKey="MOTIR" />);
    expect(await screen.findByText('Epic one')).toBeTruthy();
    await act(async () => {});
    expect(el('E2')).toBeTruthy();
    expect(noCrumbNav()).toBeNull();
  });

  it('serves a re-drilled level from the adapter CACHE — no second request for it', async () => {
    // `WorkItemRoadmap` caches per project+scope+parent. Descend (root → E1),
    // climb back, drill by hand: the child level must come from the cache. This
    // is the adapter's own cache-HIT arm — the branch the auto-descend path
    // alone never takes, since it visits each level once.
    const fetchSpy = serveWire({
      __root__: { nodes: [wireNode('E1', 'MOTIR-1', 'Lone epic', true)], edges: [] },
      E1: {
        nodes: [
          wireNode('S1', 'MOTIR-2', 'Story one', false, 'E1'),
          wireNode('S2', 'MOTIR-3', 'Story two', false, 'E1'),
        ],
        edges: [],
      },
    });

    render(<WorkItemRoadmap projectKey="MOTIR" />);
    await screen.findByText('Story one');
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2)); // root + descent

    fireEvent.click(within(crumbNav()).getByText('Roadmap')); // climb back
    expect(await screen.findByText('Lone epic')).toBeTruthy();

    fireEvent.keyDown(el('E1')!, { key: 'Enter' }); // select
    fireEvent.click(await screen.findByTestId('drill-button')); // hand drill
    expect(await screen.findByText('Story one')).toBeTruthy();

    // The root reload is a cache hit too, so the count never moved past the
    // two levels actually fetched.
    await act(async () => {});
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

// ──────────────── 2 · THE DESCEND PREDICATE'S RESIDUE BRANCHES ────────────────

describe('the auto-descend predicate — the branches the per-subtask floor leaves open', () => {
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

  it('CYCLE GUARD: a level resolving to a node already on the crumb path renders instead of looping', async () => {
    // `loadLevel` is consumer-supplied I/O. A tree that (wrongly) returns a level
    // whose single drillable node is an ANCESTOR would descend forever and hang
    // the canvas — the guard makes it fail VISIBLY by rendering the level. This
    // is the one descend-predicate arm no well-formed fixture can reach, which is
    // exactly why it belongs in the gate rather than the floor.
    // EVERY level resolves to the same single drillable node — the degenerate
    // cycle: the root offers A, and A's children offer A again.
    const cycle: RoadmapLevel = { nodes: [node('A', 'Ouroboros', true)], deps: [] };
    const load = vi.fn(() => Promise.resolve(cycle));

    render(<ProjectRoadmapCanvas loadLevel={load} autoDescendSingleParent rootLabel="Roadmap" />);

    // It descended ONCE (crumb A), then stopped and painted the level.
    expect(await screen.findByText('Ouroboros')).toBeTruthy();
    await act(async () => {});
    expect(el('A')).toBeTruthy();
    expect(crumbLabels()).toEqual(['Roadmap', 'A']);
    // Two loads total — the root, then A. A third would mean it kept descending.
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a REJECTED level load degrades to the empty state instead of throwing', async () => {
    // `fetchRoadmapLevel` is best-effort, but the canvas takes ANY loader — a
    // consumer whose fetcher rejects must land on the empty state, not tear the
    // tree down. The floor only ever resolves.
    render(
      <ProjectRoadmapCanvas
        loadLevel={() => Promise.reject(new Error('level read failed'))}
        autoDescendSingleParent
      />,
    );
    expect(await screen.findByText('Nothing on the roadmap yet')).toBeTruthy();
    expect(noCrumbNav()).toBeNull();
  });

  it('an auto-descended level that resolves EMPTY shows the drilled empty copy', async () => {
    // Distinct from the root empty state above: after a descent the canvas is
    // `drilled`, so the empty panel must name the level, not the project.
    const tree: Record<string, RoadmapLevel> = {
      __root__: { nodes: [node('P', 'Parent', true)], deps: [] },
      P: { nodes: [], deps: [] },
    };
    render(
      <ProjectRoadmapCanvas
        loadLevel={(id) => Promise.resolve(tree[id ?? '__root__'] ?? { nodes: [], deps: [] })}
        autoDescendSingleParent
        rootLabel="Roadmap"
      />,
    );
    expect(await screen.findByText('No items at this level')).toBeTruthy();
    expect(screen.getByText('This node has no children to show.')).toBeTruthy();
    expect(crumbLabels()).toEqual(['Roadmap', 'P']);
  });

  it('a MID-crumb click returns to that level and suppresses the re-descend there', async () => {
    // The floor exercises the ROOT crumb and Back. A mid-stack crumb is the
    // third navigation arm: it must truncate the stack at that entry AND arm the
    // suppression for the level it lands on, or a two-deep chain would throw the
    // user straight back to the bottom.
    const tree: Record<string, RoadmapLevel> = {
      __root__: { nodes: [node('P', 'Parent', true)], deps: [] },
      P: { nodes: [node('C', 'Child', true)], deps: [] },
      C: { nodes: [node('L1', 'Leaf one'), node('L2', 'Leaf two')], deps: [] },
    };
    render(
      <ProjectRoadmapCanvas
        loadLevel={(id) => Promise.resolve(tree[id ?? '__root__'] ?? { nodes: [], deps: [] })}
        autoDescendSingleParent
        rootLabel="Roadmap"
      />,
    );
    await screen.findByText('Leaf one');
    expect(crumbLabels()).toEqual(['Roadmap', 'P', 'C']);

    // Click the MIDDLE crumb (P) — not the root, not the active tail.
    fireEvent.click(within(crumbNav()).getByText('P'));
    expect(await screen.findByText('Child')).toBeTruthy();
    await act(async () => {});
    // The stack truncated to P…
    expect(crumbLabels()).toEqual(['Roadmap', 'P']);
    // …and it SAT STILL: C is a single drillable node, but we climbed here on
    // purpose, so the descent stays suppressed.
    expect(el('C')).toBeTruthy();
    expect(el('L1')).toBeNull();
  });

  it('Back from a TWO-deep chain returns to the level above, not to the root', async () => {
    // `goBack` picks `crumbs[length - 2]`; with one crumb that is the root
    // (the floor's case), with two it is a real intermediate level.
    const tree: Record<string, RoadmapLevel> = {
      __root__: { nodes: [node('P', 'Parent', true)], deps: [] },
      P: { nodes: [node('C', 'Child', true)], deps: [] },
      C: { nodes: [node('L1', 'Leaf one'), node('L2', 'Leaf two')], deps: [] },
    };
    render(
      <ProjectRoadmapCanvas
        loadLevel={(id) => Promise.resolve(tree[id ?? '__root__'] ?? { nodes: [], deps: [] })}
        autoDescendSingleParent
        rootLabel="Roadmap"
      />,
    );
    await screen.findByText('Leaf one');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByText('Child')).toBeTruthy();
    await act(async () => {});
    expect(crumbLabels()).toEqual(['Roadmap', 'P']);
    expect(el('L1')).toBeNull();
  });

  it('the Open affordance is inert for a node that is not drillable', async () => {
    // `handleDrill` early-returns on a non-drillable id. The affordance is only
    // rendered for a drillable node, so the arm is reached by driving the
    // ACTIVATE path on a leaf — which must select, never descend.
    const onSelect = vi.fn();
    const level: RoadmapLevel = {
      nodes: [node('A', 'Alpha'), node('B', 'Bravo')],
      deps: [],
    };
    render(
      <ProjectRoadmapCanvas
        loadLevel={() => Promise.resolve(level)}
        autoDescendSingleParent
        onSelect={onSelect}
      />,
    );
    await screen.findByText('Alpha');
    fireEvent.keyDown(el('A')!, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('A');
    expect(screen.queryByTestId('drill-button')).toBeNull();
    await act(async () => {});
    expect(noCrumbNav()).toBeNull();
  });
});

// ────────── 3 · THE SURROUNDING CANVAS CONTROLS ON THE STORY'S SURFACE ──────────

describe('the canvas controls the auto-drilled roadmap ships with', () => {
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
  const twoNodes: RoadmapLevel = {
    nodes: [node('A', 'Alpha'), node('B', 'Bravo')],
    deps: [],
  };
  const serveTwo = () => Promise.resolve(twoNodes);

  it('the "/" hotkey focuses the search field — unless the user is already typing', async () => {
    render(<ProjectRoadmapCanvas loadLevel={serveTwo} searchable />);
    await screen.findByText('Alpha');
    const search = screen.getByPlaceholderText('Search the roadmap');

    fireEvent.keyDown(window, { key: '/' });
    expect(document.activeElement).toBe(search);

    // …but a "/" typed INTO a field is a slash, not a shortcut (it would
    // otherwise steal the caret out of any composer on the page).
    const other = document.createElement('input');
    document.body.appendChild(other);
    other.focus();
    fireEvent.keyDown(other, { key: '/' });
    expect(document.activeElement).toBe(other);
    // A modified "/" is a browser shortcut, never ours.
    document.body.removeChild(other);
    search.blur();
    fireEvent.keyDown(window, { key: '/', metaKey: true });
    expect(document.activeElement).not.toBe(search);
  });

  it('locating with no match leaves the level untouched', async () => {
    // `locate()` early-returns when the query matches nothing. Without this the
    // submit would highlight `undefined` and blank the current highlight.
    render(<ProjectRoadmapCanvas loadLevel={serveTwo} searchable />);
    await screen.findByText('Alpha');
    fireEvent.change(screen.getByPlaceholderText('Search the roadmap'), {
      target: { value: 'nothing matches this' },
    });
    fireEvent.submit(screen.getByRole('search'));
    await act(async () => {});
    expect(document.querySelector('[data-highlighted]')).toBeNull();
    expect(el('A')).toBeTruthy(); // the level is still rendered
  });

  it('survives a REJECTING Fullscreen API — the overlay still opens and closes', async () => {
    // The Fullscreen API is best-effort: it rejects without a trusted user
    // gesture (headless, embedded frames). The overlay is the authoritative
    // state and must be unaffected — the `.catch()` arms exist for exactly this.
    const requestFs = vi.fn().mockRejectedValue(new Error('not allowed'));
    const exitFs = vi.fn().mockRejectedValue(new Error('not allowed'));
    (Element.prototype as unknown as { requestFullscreen: unknown }).requestFullscreen = requestFs;
    const doc = document as unknown as { exitFullscreen?: unknown; fullscreenElement?: unknown };
    const priorExit = doc.exitFullscreen;
    doc.exitFullscreen = exitFs;
    try {
      render(<ProjectRoadmapCanvas loadLevel={serveTwo} fullScreenable />);
      await screen.findByText('Alpha');
      const toggle = screen.getByTestId('fullscreen-toggle');
      const canvas = screen.getByTestId('roadmap-canvas');

      fireEvent.click(toggle);
      await act(async () => {}); // let the rejected promise settle into its catch
      expect(requestFs).toHaveBeenCalled();
      expect(canvas.getAttribute('data-fullscreen')).toBe('true');

      // Exit with a live `document.fullscreenElement`, so the API branch runs.
      Object.defineProperty(document, 'fullscreenElement', {
        value: canvas,
        configurable: true,
      });
      fireEvent.click(toggle);
      await act(async () => {});
      expect(exitFs).toHaveBeenCalled();
      expect(canvas.hasAttribute('data-fullscreen')).toBe(false);
    } finally {
      delete (Element.prototype as unknown as { requestFullscreen?: unknown }).requestFullscreen;
      if (priorExit === undefined) delete doc.exitFullscreen;
      else doc.exitFullscreen = priorExit;
      Object.defineProperty(document, 'fullscreenElement', {
        value: null,
        configurable: true,
      });
    }
  });

  it('collapses when the browser leaves full screen by its OWN route', async () => {
    // The user can exit via the OS/browser affordance, which fires
    // `fullscreenchange` without ever touching our toggle. Without the sync the
    // overlay would stay up over a non-fullscreen window.
    (Element.prototype as unknown as { requestFullscreen: unknown }).requestFullscreen = vi
      .fn()
      .mockResolvedValue(undefined);
    try {
      render(<ProjectRoadmapCanvas loadLevel={serveTwo} fullScreenable />);
      await screen.findByText('Alpha');
      const canvas = screen.getByTestId('roadmap-canvas');
      fireEvent.click(screen.getByTestId('fullscreen-toggle'));
      expect(canvas.getAttribute('data-fullscreen')).toBe('true');

      // The browser reports it is no longer full screen.
      Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
      fireEvent(document, new Event('fullscreenchange'));
      expect(canvas.hasAttribute('data-fullscreen')).toBe(false);
    } finally {
      delete (Element.prototype as unknown as { requestFullscreen?: unknown }).requestFullscreen;
    }
  });

  it('ignores a non-Escape key while full screen', async () => {
    (Element.prototype as unknown as { requestFullscreen: unknown }).requestFullscreen = vi
      .fn()
      .mockResolvedValue(undefined);
    try {
      render(<ProjectRoadmapCanvas loadLevel={serveTwo} fullScreenable />);
      await screen.findByText('Alpha');
      const canvas = screen.getByTestId('roadmap-canvas');
      fireEvent.click(screen.getByTestId('fullscreen-toggle'));
      fireEvent.keyDown(document.body, { key: 'a' });
      expect(canvas.getAttribute('data-fullscreen')).toBe('true'); // still expanded
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(canvas.hasAttribute('data-fullscreen')).toBe(false);
    } finally {
      delete (Element.prototype as unknown as { requestFullscreen?: unknown }).requestFullscreen;
    }
  });

  it('pressing empty canvas clears the selection', async () => {
    // The engine reports a background press as a PAN gesture that never moved,
    // not as a click — so the selection-clearing path is only reachable through
    // the real pointer sequence. happy-dom has no pointer capture, so the two
    // capture calls the gesture makes are stubbed.
    render(<ProjectRoadmapCanvas loadLevel={serveTwo} onSelect={vi.fn()} />);
    await screen.findByText('Alpha');
    fireEvent.keyDown(el('A')!, { key: 'Enter' });
    expect(el('A')!.querySelector('[data-selected]')).toBeTruthy();

    const viewport = screen.getByLabelText('Project roadmap');
    const proto = Element.prototype as unknown as Record<string, unknown>;
    proto['setPointerCapture'] ??= () => {};
    proto['releasePointerCapture'] ??= () => {};
    fireEvent.pointerDown(viewport, { pointerId: 1, clientX: 5, clientY: 5, button: 0 });
    fireEvent.pointerUp(viewport, { pointerId: 1, clientX: 5, clientY: 5, button: 0 });
    await act(async () => {});
    expect(document.querySelector('[data-selected]')).toBeNull();
  });
});
