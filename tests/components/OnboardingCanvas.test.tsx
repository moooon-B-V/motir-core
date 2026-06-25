// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { OnboardingCanvas } from '@/components/onboarding/OnboardingCanvas';
import { type DiscoveryState, initialDiscoveryState } from '@/lib/onboarding/discoveryLoop';
import type { DirectionDocView } from '@/lib/onboarding/directionDoc';

// A condensed peek payload the /api/work-items/peek read returns for MOTIR-1.
const PEEK = {
  identifier: 'MOTIR-1',
  title: 'Epic one',
  kind: 'epic',
  statusLabel: 'In Progress',
  statusCategory: 'in_progress',
  descriptionMd: 'The first epic.',
  type: null,
  executor: null,
  assigneeName: 'Marco Ortiz',
  reporterName: 'Alice Chen',
  priority: 'medium',
  labels: [],
  components: [],
  dueLabel: null,
  sprintName: null,
  storyPoints: null,
  estimateLabel: null,
  customFields: [],
  createdAt: '2026-06-02T00:00:00.000Z',
  updatedAt: '2026-06-10T00:00:00.000Z',
  parent: null,
  readiness: null,
};

beforeEach(() => {
  // useCanvasLayout fetches the saved layout on mount — stub it (empty → auto-layout).
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ layout: { positions: [] } }) })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const doc = (kind: DirectionDocView['kind'], body: string): DirectionDocView => ({
  kind,
  contentMd: body,
  version: 2,
});

function hubState(over: Partial<DiscoveryState> = {}): DiscoveryState {
  return {
    ...initialDiscoveryState(),
    producedKinds: ['discovery', 'vision'],
    activeKind: 'vision',
    docs: {
      discovery: doc('discovery', '# D\n\nSend and track invoices.'),
      vision: doc('vision', '# V\n\nInvoices, reminders in v1.'),
    },
    session: { ...initialDiscoveryState().session, classification: 'startup', platform: 'web' },
    ...over,
  };
}

describe('OnboardingCanvas', () => {
  // The canvas holds a loading state until the saved layout resolves (MOTIR-1253),
  // so node assertions await the post-load render (`findBy*`).
  it('renders the stations + the idea node on the spatial canvas', async () => {
    renderWithIntl(
      <OnboardingCanvas
        state={hubState()}
        idea="An invoicing tool"
        onOpen={vi.fn()}
        onOpenDesign={vi.fn()}
      />,
    );
    expect(await screen.findByText('Understanding your project')).toBeTruthy();
    expect(screen.getByText("What we'll build")).toBeTruthy();
    expect(screen.getByText('Design the look')).toBeTruthy();
    expect(screen.getByText('Plan → your project')).toBeTruthy();
    expect(screen.getByText('Your idea')).toBeTruthy();
    // captured findings (the structured facts) render on the done discovery tier
    expect(screen.getByText('Type — startup')).toBeTruthy();
  });

  it('shows a loading state until the saved layout resolves (MOTIR-1253)', () => {
    // A fetch that never resolves keeps `loaded` false → the spinner stays.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
    renderWithIntl(
      <OnboardingCanvas state={hubState()} idea="x" onOpen={vi.fn()} onOpenDesign={vi.fn()} />,
    );
    expect(screen.getByRole('status', { name: 'Loading your roadmap…' })).toBeTruthy();
    // nodes are NOT painted yet (so they can't flash at the auto-layout first)
    expect(screen.queryByText('Understanding your project')).toBeNull();
  });

  it('draws the read-only dependency chain as edges', async () => {
    renderWithIntl(
      <OnboardingCanvas state={hubState()} idea="x" onOpen={vi.fn()} onOpenDesign={vi.fn()} />,
    );
    // idea→discovery→vision→feasibility→validation→design→plan = 6 edges
    const edges = await screen.findByTestId('canvas-edges');
    expect(edges.querySelectorAll('path')).toHaveLength(6);
  });

  it('omits the idea node + its edge when there is no idea (resume)', async () => {
    renderWithIntl(
      <OnboardingCanvas state={hubState()} idea={null} onOpen={vi.fn()} onOpenDesign={vi.fn()} />,
    );
    const edges = await screen.findByTestId('canvas-edges');
    expect(screen.queryByText('Your idea')).toBeNull();
    expect(edges.querySelectorAll('path')).toHaveLength(5);
  });

  it('activating a produced tier opens its review; an upcoming station does not', async () => {
    const onOpen = vi.fn();
    renderWithIntl(
      <OnboardingCanvas state={hubState()} idea={null} onOpen={onOpen} onOpenDesign={vi.fn()} />,
    );
    await screen.findByTestId('canvas-edges');
    fireEvent.keyDown(document.querySelector('[data-node-id="discovery"]')!, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith('discovery');
    onOpen.mockClear();
    fireEvent.keyDown(document.querySelector('[data-node-id="design"]')!, { key: 'Enter' });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('shows the cascade-back canvas states — Revisiting + Will refresh (1179)', async () => {
    renderWithIntl(
      <OnboardingCanvas
        state={hubState()}
        idea={null}
        onOpen={vi.fn()}
        onOpenDesign={vi.fn()}
        revisitingKind="discovery"
        willRefresh={['vision']}
      />,
    );
    expect(await screen.findByText('Revisiting')).toBeTruthy();
    expect(screen.getByText('Will refresh')).toBeTruthy();
  });

  // The design-phase gate (7.3.69): the `design` station is dropped from a mobile /
  // other project's roadmap, and the chain bridges validation → plan.
  it('omits the design station for a mobile project and bridges the chain', async () => {
    renderWithIntl(
      <OnboardingCanvas
        state={hubState({
          session: { ...hubState().session, platform: 'mobile' },
        })}
        idea="x"
        onOpen={vi.fn()}
        onOpenDesign={vi.fn()}
      />,
    );
    const edges = await screen.findByTestId('canvas-edges');
    expect(screen.queryByText('Design the look')).toBeNull();
    expect(document.querySelector('[data-node-id="design"]')).toBeNull();
    // idea→discovery→vision→feasibility→validation→plan (design contracted) = 5 edges
    expect(edges.querySelectorAll('path')).toHaveLength(5);
    expect(screen.getByText('Plan → your project')).toBeTruthy();
  });

  // Step 5: the design station is VISIBLE on a web roadmap from the start, but is
  // not ENTERABLE (no CTA, click is inert) until the tiers are complete.
  it('shows the design station upcoming but inert before the tiers complete (web)', async () => {
    const onOpenDesign = vi.fn();
    renderWithIntl(
      <OnboardingCanvas state={hubState()} idea="x" onOpen={vi.fn()} onOpenDesign={onOpenDesign} />,
    );
    await screen.findByTestId('canvas-edges');
    expect(screen.getByText('Design the look')).toBeTruthy(); // roadmap node visible
    expect(document.querySelector('[data-node-id="design"]')).not.toBeNull();
    expect(screen.queryByText('Design your look')).toBeNull(); // entry CTA absent
    fireEvent.keyDown(document.querySelector('[data-node-id="design"]')!, { key: 'Enter' });
    expect(onOpenDesign).not.toHaveBeenCalled(); // click is inert
  });

  // MOTIR-1352: the work-item quick-view peek works on the onboarding canvas too —
  // once the user drills from the "Your plan" preview into the produced tree, a
  // work-item node's View button opens the SAME peek the roadmap uses.
  it('opens the work-item quick-view from a drilled work-item node', async () => {
    const epic = {
      id: 'EP1',
      parentId: null,
      kind: 'epic',
      identifier: 'MOTIR-1',
      title: 'Epic one',
      status: 'in_progress',
      isDone: false,
      hasChildren: false,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('/api/canvas-layout'))
          return { ok: true, json: async () => ({ layout: { positions: [] } }) };
        if (u.includes('/api/work-items/peek')) return { ok: true, json: async () => PEEK };
        if (u.includes('/roadmap'))
          return { ok: true, json: async () => ({ nodes: [epic], edges: [] }) };
        return { ok: true, json: async () => ({}) };
      }),
    );
    renderWithIntl(
      <OnboardingCanvas
        state={hubState()}
        idea="x"
        onOpen={vi.fn()}
        onOpenDesign={vi.fn()}
        projectKey="MOTIR"
      />,
    );
    // The "Your plan" preview node appears at the root once the tree loads; select
    // it and drill into the produced epics.
    const planNode = await waitFor(() => {
      const n = document.querySelector('[data-node-id="__plan__"]');
      if (!n) throw new Error('plan preview not yet rendered');
      return n;
    });
    fireEvent.keyDown(planNode, { key: 'Enter' }); // select the preview
    fireEvent.click(await screen.findByTestId('drill-button')); // Open → drill to epics
    // The epic now renders as a real (viewable) work-item node — select it + View.
    const epicNode = await waitFor(() => {
      const n = document.querySelector('[data-node-id="EP1"]');
      if (!n) throw new Error('epic node not yet rendered');
      return n;
    });
    fireEvent.keyDown(epicNode, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('view-button'));
    // The shipped peek opens and streams the item from /api/work-items/peek.
    expect(await screen.findByRole('dialog')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('quick-view-open-full').getAttribute('href')).toBe(
        '/items/MOTIR-1',
      ),
    );
  });

  it('makes the design station enterable once the tiers are complete (web)', async () => {
    const onOpenDesign = vi.fn();
    renderWithIntl(
      <OnboardingCanvas
        state={hubState({ session: { ...hubState().session, status: 'tiers_complete' } })}
        idea="x"
        onOpen={vi.fn()}
        onOpenDesign={onOpenDesign}
      />,
    );
    await screen.findByTestId('canvas-edges');
    expect(screen.getByText('Design your look')).toBeTruthy(); // entry CTA present
    fireEvent.keyDown(document.querySelector('[data-node-id="design"]')!, { key: 'Enter' });
    expect(onOpenDesign).toHaveBeenCalled();
  });
});
