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
  it('renders the stations + the idea node on the spatial canvas', () => {
    renderWithIntl(
      <OnboardingCanvas state={hubState()} idea="An invoicing tool" onOpen={vi.fn()} />,
    );
    expect(screen.getByText('Understanding your idea')).toBeTruthy();
    expect(screen.getByText("What we'll build")).toBeTruthy();
    expect(screen.getByText('Design the look')).toBeTruthy();
    expect(screen.getByText('Plan → your epics')).toBeTruthy();
    expect(screen.getByText('Your idea')).toBeTruthy();
    // captured findings (the structured facts) render on the done discovery tier
    expect(screen.getByText('Type — startup')).toBeTruthy();
  });

  it('draws the read-only dependency chain as edges', () => {
    renderWithIntl(<OnboardingCanvas state={hubState()} idea="x" onOpen={vi.fn()} />);
    // idea→discovery→vision→feasibility→validation→design→plan = 6 edges
    expect(screen.getByTestId('canvas-edges').querySelectorAll('path')).toHaveLength(6);
  });

  it('omits the idea node + its edge when there is no idea (resume)', () => {
    renderWithIntl(<OnboardingCanvas state={hubState()} idea={null} onOpen={vi.fn()} />);
    expect(screen.queryByText('Your idea')).toBeNull();
    expect(screen.getByTestId('canvas-edges').querySelectorAll('path')).toHaveLength(5);
  });

  it('activating a produced tier opens its review; an upcoming station does not', () => {
    const onOpen = vi.fn();
    renderWithIntl(<OnboardingCanvas state={hubState()} idea={null} onOpen={onOpen} />);
    fireEvent.keyDown(document.querySelector('[data-node-id="discovery"]')!, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith('discovery');
    onOpen.mockClear();
    fireEvent.keyDown(document.querySelector('[data-node-id="design"]')!, { key: 'Enter' });
    expect(onOpen).not.toHaveBeenCalled();
  });
});
