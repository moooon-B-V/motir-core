// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { OnboardingCanvas } from '@/components/onboarding/OnboardingCanvas';
import { type DiscoveryState, initialDiscoveryState } from '@/lib/onboarding/discoveryLoop';
import type { DirectionDocView } from '@/lib/onboarding/directionDoc';

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
      <OnboardingCanvas state={hubState()} idea="An invoicing tool" onOpenDesign={vi.fn()} />,
    );
    expect(await screen.findByText('Understanding your idea')).toBeTruthy();
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
    renderWithIntl(<OnboardingCanvas state={hubState()} idea="x" onOpenDesign={vi.fn()} />);
    expect(screen.getByRole('status', { name: 'Loading your roadmap…' })).toBeTruthy();
    // nodes are NOT painted yet (so they can't flash at the auto-layout first)
    expect(screen.queryByText('Understanding your idea')).toBeNull();
  });

  it('draws the read-only dependency chain as edges', async () => {
    renderWithIntl(<OnboardingCanvas state={hubState()} idea="x" onOpenDesign={vi.fn()} />);
    // idea→discovery→vision→feasibility→validation→design→plan = 6 edges
    const edges = await screen.findByTestId('canvas-edges');
    expect(edges.querySelectorAll('path')).toHaveLength(6);
  });

  it('omits the idea node + its edge when there is no idea (resume)', async () => {
    renderWithIntl(<OnboardingCanvas state={hubState()} idea={null} onOpenDesign={vi.fn()} />);
    const edges = await screen.findByTestId('canvas-edges');
    expect(screen.queryByText('Your idea')).toBeNull();
    expect(edges.querySelectorAll('path')).toHaveLength(5);
  });

  // Per the 7.20.10 design (MOTIR-1355): selecting a station only HIGHLIGHTS it;
  // a PRODUCED tier surfaces a "View" button (opens its doc in the tier-doc viewer),
  // while a non-tier station (design) carries no View button.
  it('surfaces a View button on a selected produced tier; not on a non-tier station', async () => {
    renderWithIntl(<OnboardingCanvas state={hubState()} idea={null} onOpenDesign={vi.fn()} />);
    await screen.findByTestId('canvas-edges');

    fireEvent.keyDown(document.querySelector('[data-node-id="discovery"]')!, { key: 'Enter' });
    expect(
      await screen.findByRole('button', { name: /view understanding your idea/i }),
    ).toBeTruthy();

    // Selecting the design station (not a direction tier) carries no View button.
    fireEvent.keyDown(document.querySelector('[data-node-id="design"]')!, { key: 'Enter' });
    expect(screen.queryByRole('button', { name: /^view /i })).toBeNull();
  });

  it('shows the cascade-back canvas states — Revisiting + Will refresh (1179)', async () => {
    renderWithIntl(
      <OnboardingCanvas
        state={hubState()}
        idea={null}
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
    renderWithIntl(<OnboardingCanvas state={hubState()} idea="x" onOpenDesign={onOpenDesign} />);
    await screen.findByTestId('canvas-edges');
    expect(screen.getByText('Design the look')).toBeTruthy(); // roadmap node visible
    expect(document.querySelector('[data-node-id="design"]')).not.toBeNull();
    expect(screen.queryByText('Design your look')).toBeNull(); // entry CTA absent
    fireEvent.keyDown(document.querySelector('[data-node-id="design"]')!, { key: 'Enter' });
    expect(onOpenDesign).not.toHaveBeenCalled(); // click is inert
  });

  it('makes the design station enterable once the tiers are complete (web)', async () => {
    const onOpenDesign = vi.fn();
    renderWithIntl(
      <OnboardingCanvas
        state={hubState({ session: { ...hubState().session, status: 'tiers_complete' } })}
        idea="x"
        onOpenDesign={onOpenDesign}
      />,
    );
    await screen.findByTestId('canvas-edges');
    expect(screen.getByText('Design your look')).toBeTruthy(); // entry CTA present
    fireEvent.keyDown(document.querySelector('[data-node-id="design"]')!, { key: 'Enter' });
    expect(onOpenDesign).toHaveBeenCalled();
  });
});
