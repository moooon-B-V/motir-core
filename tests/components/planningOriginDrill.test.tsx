// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { WorkItemRoadmap } from '@/components/planning/WorkItemRoadmap';
import { StationCard } from '@/components/onboarding/StationNode';
import type { PreplanStateDTO } from '@/lib/dto/aiPreplan';
import { initialDiscoveryState } from '@/lib/onboarding/discoveryLoop';

// THE ROADMAP'S PLANNING CARD IS A DOOR (MOTIR-2205 / design
// `design/roadmap/planning-origin-drill.*`). Two hops, both of them shipped canvas
// grammar: select the phase card → the canvas's "Open ›" pill → the pre-plan STATION
// level; select a produced station → the canvas's "View" button → its direction doc.
// Plus the honest badge: what the card ASSERTS follows the produced set, not the
// onboarding-ran marker that only records the journey RAN.
//
// These drive the assembled surface (`WorkItemRoadmap`), because every claim here is
// about the WIRING between shipped parts — the drill path, which level gets served
// for it, which stations are openable, and what the pre-plan read is allowed to hold
// up. Asserting the builders alone would prove none of that.

const ROADMAP_URL = /\/api\/projects\/[^/]+\/roadmap/;
const PREPLAN_URL = '/api/ai/pre-plan';

/** Two roots, so the adapter's AUTO-DRILL never descends past the level under test. */
const root = {
  nodes: [
    {
      id: 'E1',
      parentId: null,
      kind: 'epic',
      identifier: 'MOTIR-1',
      title: 'Epic one',
      status: 'in_progress',
      isDone: false,
      hasChildren: true,
    },
    {
      id: 'E2',
      parentId: null,
      kind: 'epic',
      identifier: 'MOTIR-3',
      title: 'Epic two',
      status: 'todo',
      isDone: false,
      hasChildren: false,
    },
  ],
  edges: [],
};

/** A single-epic root — the MOTIR-1824 auto-descend shape. */
const singleEpicRoot = { nodes: [root.nodes[0]], edges: [] };
const e1Children = {
  nodes: [
    {
      id: 'S1',
      parentId: 'E1',
      kind: 'story',
      identifier: 'MOTIR-2',
      title: 'Story one',
      status: 'done',
      isDone: true,
      hasChildren: false,
    },
  ],
  edges: [],
};

function preplan(kinds: Array<'discovery' | 'vision' | 'feasibility' | 'validation'>) {
  return {
    session: {
      classification: 'startup',
      platform: 'web',
      designStarter: null,
      designChoice: null,
      validationTiming: null,
      docSkipSet: [],
      currentGate: null,
      status: 'tiers_complete',
      conversation: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    docs: kinds.map((kind) => ({
      kind,
      currentBody: `# ${kind}\n\nWhat it captured for ${kind}.`,
      currentVersion: 1,
      summary: [],
      versions: [],
    })),
    catalog: null,
  } as unknown as PreplanStateDTO;
}

/**
 * Stub the two browser reads the surface makes. `preplanState` is what
 * `/api/ai/pre-plan` resolves to; `preplanFails` makes that read reject outright
 * (the motir-ai-is-down case). `roadmap` counts every per-level roadmap fetch, so a
 * test can prove the station level was served WITHOUT one.
 */
function stubFetch({
  preplanState = preplan(['discovery', 'vision', 'feasibility', 'validation']),
  preplanFails = false,
  levels = { root, e1Children },
}: {
  preplanState?: PreplanStateDTO | null;
  preplanFails?: boolean;
  levels?: { root: unknown; e1Children?: unknown };
} = {}) {
  const roadmapCalls: string[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes(PREPLAN_URL)) {
      if (preplanFails) throw new Error('motir-ai is down');
      if (preplanState === null) return { ok: false, status: 502, json: async () => ({}) };
      return { ok: true, json: async () => preplanState };
    }
    if (ROADMAP_URL.test(u)) {
      roadmapCalls.push(u);
      if (u.includes('parentId=E1')) return { ok: true, json: async () => levels.e1Children };
      return { ok: true, json: async () => levels.root };
    }
    return { ok: true, json: async () => ({}) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return { roadmapCalls, fetchMock };
}

function node(id: string) {
  return document.querySelector(`[data-node-id="${id}"]`);
}

/** Select the phase card and activate its "Open ›" pill. */
async function drillIntoThePhaseCard() {
  fireEvent.keyDown(node('__planning_origin__')!, { key: 'Enter' });
  fireEvent.click(await screen.findByTestId('drill-button'));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto['setPointerCapture'] ??= () => {};
  proto['releasePointerCapture'] ??= () => {};
});

describe('the phase card drills into the pre-plan stations (MOTIR-2205)', () => {
  it('drills to the station level, and serves it WITHOUT a roadmap-level fetch', async () => {
    const { roadmapCalls } = stubFetch();
    render(<WorkItemRoadmap projectKey="MOTIR" showPlanningOrigin />);
    await screen.findByTestId('planning-origin');
    const before = roadmapCalls.length;

    await drillIntoThePhaseCard();

    // The four stations the design names, as the shipped StationCard.
    expect(await screen.findByText('Understanding your project')).toBeTruthy();
    expect(screen.getByText("What we'll build")).toBeTruthy();
    expect(screen.getByText('Is it worth building?')).toBeTruthy();
    expect(screen.getByText('Will people want it?')).toBeTruthy();
    // …and NOT the two stations that hold no document (design DECISION 1).
    expect(screen.queryByText('Design the look')).toBeNull();
    expect(screen.queryByText('Plan → your project')).toBeNull();
    // Synthetic: no work item backs these nodes, so no per-level roadmap read fired.
    expect(roadmapCalls.length).toBe(before);
  });

  it('reads the design crumb label, and Back returns to the root level', async () => {
    stubFetch();
    render(<WorkItemRoadmap projectKey="MOTIR" showPlanningOrigin />);
    await screen.findByTestId('planning-origin');
    await drillIntoThePhaseCard();
    await screen.findByText('Understanding your project');

    // The shipped chrome — the canvas's own breadcrumb, not a new one.
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(crumbs.textContent).toContain('Planning');
    expect(crumbs.querySelector('[aria-current="page"]')!.textContent).toBe('Planning');

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByText('Epic one')).toBeTruthy();
    expect(screen.getByTestId('planning-origin')).toBeTruthy();
  });

  it('offers View on a PRODUCED station only, and it opens that tier’s doc', async () => {
    stubFetch({ preplanState: preplan(['discovery', 'vision']) });
    render(<WorkItemRoadmap projectKey="MOTIR" showPlanningOrigin />);
    await screen.findByTestId('planning-origin');
    await drillIntoThePhaseCard();
    await screen.findByText('Understanding your project');

    // An UNPRODUCED tier: selecting it surfaces no View button at all…
    fireEvent.keyDown(node('validation')!, { key: 'Enter' });
    await act(async () => {});
    expect(screen.queryByTestId('view-button')).toBeNull();

    // …a produced one does, and View opens the shipped TierDocModal for that tier.
    fireEvent.keyDown(node('discovery')!, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('view-button'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Direction · Discovery');
    // origin="roadmap" → the head's full-page link stays IN-SHELL.
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Open full page' }).getAttribute('href')).toBe(
        '/direction/discovery',
      ),
    );
  });

  it('walks select → drill → select → open the doc BY KEYBOARD ALONE', async () => {
    stubFetch();
    render(<WorkItemRoadmap projectKey="MOTIR" showPlanningOrigin />);
    const card = await waitFor(() => {
      const n = node('__planning_origin__');
      if (!n) throw new Error('phase card not yet rendered');
      return n as HTMLElement;
    });

    // ① the node wrapper is a real focus target, and Enter selects it.
    expect(card.getAttribute('tabindex')).toBe('0');
    card.focus();
    expect(document.activeElement).toBe(card);
    fireEvent.keyDown(card, { key: 'Enter' });

    // ② the Open pill is a real <button>, so Tab reaches it and Enter activates it.
    const open = (await screen.findByTestId('drill-button')) as HTMLButtonElement;
    expect(open.tagName).toBe('BUTTON');
    open.focus();
    fireEvent.keyDown(open, { key: 'Enter' });
    fireEvent.click(open); // the browser's implicit click for Enter on a button

    // ③ a station node is focusable and Enter selects it.
    const station = (await waitFor(() => {
      const n = node('discovery');
      if (!n) throw new Error('station not yet rendered');
      return n;
    })) as HTMLElement;
    expect(station.getAttribute('tabindex')).toBe('0');
    station.focus();
    fireEvent.keyDown(station, { key: 'Enter' });

    // ④ View is a real <button> with an accessible name; Enter opens the doc.
    const view = (await screen.findByTestId('view-button')) as HTMLButtonElement;
    expect(view.tagName).toBe('BUTTON');
    expect(view.getAttribute('aria-label')).toBe('View Understanding your project');
    view.focus();
    fireEvent.keyDown(view, { key: 'Enter' });
    fireEvent.click(view);
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('a pointer DRAG on the phase card does not drill', async () => {
    stubFetch();
    render(<WorkItemRoadmap projectKey="MOTIR" showPlanningOrigin />);
    const card = await waitFor(() => {
      const n = node('__planning_origin__');
      if (!n) throw new Error('phase card not yet rendered');
      return n as HTMLElement;
    });

    // The engine reads a press that MOVED past the slop as a drag, never a click, so
    // it neither selects nor drills — the drill is the Open pill and nothing else.
    fireEvent.pointerDown(card, { pointerId: 1, clientX: 10, clientY: 10, button: 0 });
    fireEvent.pointerMove(card, { pointerId: 1, clientX: 140, clientY: 96 });
    fireEvent.pointerUp(card, { pointerId: 1, clientX: 140, clientY: 96, button: 0 });
    await act(async () => {});

    expect(screen.queryByTestId('drill-button')).toBeNull();
    expect(screen.queryByText('Understanding your project')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
    expect(screen.getByText('Epic one')).toBeTruthy(); // still the root level
  });

  // The MOTIR-1824 guard, re-asserted because this card gave the node a drill path:
  // drillable and decorative are INDEPENDENT axes. Were `decorative` dropped, the
  // root level would count two nodes and an onboarded single-epic project would stop
  // auto-descending exactly as it did before that bug was fixed.
  it('auto-descend still ignores the origin node on a single-epic project', async () => {
    stubFetch({ levels: { root: singleEpicRoot, e1Children } });
    render(<WorkItemRoadmap projectKey="MOTIR" showPlanningOrigin />);

    // It descended INTO the single epic rather than resting on card + epic.
    expect(await screen.findByText('Story one')).toBeTruthy();
    expect(screen.queryByTestId('planning-origin')).toBeNull();
  });
});

describe('the phase card’s badge follows the documents, not the marker (MOTIR-2205)', () => {
  it('keeps the mint Complete verdict when all four tiers produced', async () => {
    stubFetch();
    render(<WorkItemRoadmap projectKey="MOTIR" showPlanningOrigin />);
    expect((await screen.findByTestId('planning-origin-chip')).textContent).toBe('Complete');
    // Every stage checked — the shipped, unchanged state A.
    expect(document.querySelectorAll('[data-stage-done]').length).toBe(5);
  });

  it('reports the COUNT for a partial journey, and drops the unproduced stages’ checks', async () => {
    stubFetch({ preplanState: preplan(['discovery', 'vision']) });
    render(<WorkItemRoadmap projectKey="MOTIR" showPlanningOrigin />);
    expect((await screen.findByTestId('planning-origin-chip')).textContent).toBe('2 of 4 docs');
    // Idea + Plan (attested by the marker itself) + Discover + Shape; Validate is
    // absent, because neither of the tiers it collapses produced anything.
    expect(document.querySelectorAll('[data-stage-done]').length).toBe(4);
  });

  it('says "No docs" — and never "Complete" — for a marker-stamped project with an EMPTY journey', async () => {
    stubFetch({ preplanState: preplan([]) });
    render(<WorkItemRoadmap projectKey="MOTIR" showPlanningOrigin />);

    expect((await screen.findByTestId('planning-origin-chip')).textContent).toBe('No docs');
    expect(screen.queryByText('Complete')).toBeNull();
    // Only the two stages the onboarding-ran marker genuinely attests stay checked.
    expect(document.querySelectorAll('[data-stage-done]').length).toBe(2);

    // …and drilling it lands on the design's empty station level, not a blank canvas:
    // four `upcoming` stations naming the journey's shape, none of them openable.
    await drillIntoThePhaseCard();
    expect(await screen.findByText('Understanding your project')).toBeTruthy();
    expect(screen.getByText('Will people want it?')).toBeTruthy();
    fireEvent.keyDown(node('discovery')!, { key: 'Enter' });
    await act(async () => {});
    expect(screen.queryByTestId('view-button')).toBeNull();
  });

  it('a motir-ai FAILURE degrades the card and the level — never an error on /roadmap', async () => {
    stubFetch({ preplanFails: true });
    render(<WorkItemRoadmap projectKey="MOTIR" showPlanningOrigin />);
    await screen.findByTestId('planning-origin');
    // The roadmap itself is unaffected, and the card claims nothing it cannot prove:
    // no chip at all, and no all-stages-checked strip.
    expect(screen.getByText('Epic one')).toBeTruthy();
    await act(async () => {});
    expect(screen.queryByTestId('planning-origin-chip')).toBeNull();
    expect(screen.queryByText('Complete')).toBeNull();
    expect(document.querySelectorAll('[data-stage-done]').length).toBe(2);

    // The drill still lands somewhere worth being, not on an error.
    await drillIntoThePhaseCard();
    expect(await screen.findByText('Understanding your project')).toBeTruthy();
  });

  it('a non-OK pre-plan response is the same honest chip-less state', async () => {
    stubFetch({ preplanState: null });
    render(<WorkItemRoadmap projectKey="MOTIR" showPlanningOrigin />);
    await screen.findByTestId('planning-origin');
    await act(async () => {});
    expect(screen.queryByTestId('planning-origin-chip')).toBeNull();
  });

  it('never reads pre-plan at all when the card is not rendered (never-onboarded, or sprint scope)', async () => {
    const { fetchMock } = stubFetch();
    render(<WorkItemRoadmap projectKey="MOTIR" />);
    await screen.findByText('Epic one');
    await act(async () => {});
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes(PREPLAN_URL))).toBe(false);

    cleanup();
    const sprint = stubFetch();
    render(<WorkItemRoadmap projectKey="MOTIR" scope="sprint" showPlanningOrigin />);
    await screen.findByText('Epic one');
    await act(async () => {});
    expect(sprint.fetchMock.mock.calls.some(([u]) => String(u).includes(PREPLAN_URL))).toBe(false);
  });

  it('reads pre-plan ONCE for both the badge and the drilled level', async () => {
    const { fetchMock } = stubFetch();
    render(<WorkItemRoadmap projectKey="MOTIR" showPlanningOrigin />);
    await screen.findByTestId('planning-origin-chip');
    await drillIntoThePhaseCard();
    await screen.findByText('Understanding your project');

    // The badge's read and the drill's read are the SAME promise — a drill never
    // pays a second motir-ai round trip.
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes(PREPLAN_URL)).length).toBe(1);
  });
});

// The one prop this card had to relax on a SHIPPED component. `StationCard.session`
// was REQUIRED and the roadmap has no live `DiscoverySession` — so it becomes
// optional, ADDITIVELY: every existing call site keeps passing it and keeps
// rendering exactly what it rendered before.
describe('StationCard.session is relaxed ADDITIVELY (MOTIR-2205)', () => {
  const doneDiscovery = {
    kind: 'discovery' as const,
    state: 'done' as const,
    optional: false,
    openable: true,
  };
  // A tier with a BODY but no structured summary — the one path that reads
  // `session`, via the classification/platform fallback in CapturedFindings.
  const legacyDoc = { kind: 'discovery' as const, contentMd: '# D\n\nSend invoices.' };
  const session = {
    ...initialDiscoveryState().session,
    classification: 'startup',
    platform: 'web',
  };

  it('renders the session-derived facts UNCHANGED when a session is passed', () => {
    render(<StationCard station={doneDiscovery} doc={legacyDoc} session={session} />);
    expect(screen.getByText('Type — startup')).toBeTruthy();
    expect(screen.getByText('Platform — web')).toBeTruthy();
    expect(screen.getByText('Send invoices.')).toBeTruthy();
    expect(screen.getByText('Reviewed')).toBeTruthy();
  });

  it('renders WITHOUT a session — the facts it cannot know are simply absent', () => {
    render(<StationCard station={doneDiscovery} doc={legacyDoc} />);
    expect(screen.queryByText('Type — startup')).toBeNull();
    expect(screen.queryByText('Platform — web')).toBeNull();
    // Everything the doc itself carries still renders.
    expect(screen.getByText('Send invoices.')).toBeTruthy();
    expect(screen.getByText('Reviewed')).toBeTruthy();
  });

  it('keeps the design station’s designChoice gate working in both shapes', () => {
    const designStation = {
      kind: 'design' as const,
      state: 'upcoming' as const,
      optional: true,
      openable: false,
    };
    // A chosen design suppresses the "can skip" tag (MOTIR-1363) — the onboarding
    // behaviour, unchanged.
    render(
      <StationCard
        station={designStation}
        doc={undefined}
        session={{
          ...session,
          designChoice: { styleId: 'soft-playful', paletteId: 'motir', typeId: 'motir' },
        }}
      />,
    );
    expect(screen.queryByText('can skip')).toBeNull();
    cleanup();

    // With no session at all there is no choice to suppress it, so the tag shows —
    // the same branch a session with `designChoice: null` takes.
    render(<StationCard station={designStation} doc={undefined} />);
    expect(screen.getByText('can skip')).toBeTruthy();
  });
});
