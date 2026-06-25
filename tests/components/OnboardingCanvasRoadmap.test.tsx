// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { OnboardingCanvas } from '@/components/onboarding/OnboardingCanvas';
import { type DiscoveryState, initialDiscoveryState } from '@/lib/onboarding/discoveryLoop';

// The onboarding canvas shows the WHOLE project: the pre-plan stations PLUS the
// produced work-item tree, read ONE LEVEL AT A TIME from the per-level roadmap
// endpoint (`/api/projects/[key]/roadmap?parentId=`). At the top level the plan
// is a compact "Your plan" PREVIEW node (MOTIR-1333) hung off the plan station —
// NOT every epic fanned out; drilling it reveals the real epic roots.

function hubState(): DiscoveryState {
  return {
    ...initialDiscoveryState(),
    producedKinds: ['discovery', 'vision'],
    activeKind: 'vision',
    session: { ...initialDiscoveryState().session, classification: 'startup', platform: 'web' },
  };
}

const rootLevel = {
  nodes: [
    {
      id: 'e1',
      parentId: null,
      kind: 'epic',
      identifier: 'MOTIR-10',
      title: 'Billing epic',
      status: 'todo',
      isDone: false,
      hasChildren: true,
    },
  ],
  edges: [],
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).includes('/roadmap')) return { ok: true, json: async () => rootLevel };
      return { ok: true, json: async () => ({ layout: { positions: [] } }) }; // canvas-layout
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('OnboardingCanvas — produced work-item tree (per level)', () => {
  it('shows a "Your plan" preview at the top level and drills into the epic roots', async () => {
    renderWithIntl(
      <OnboardingCanvas
        state={hubState()}
        idea="x"
        projectKey="MOTIR"
        onOpen={vi.fn()}
        onOpenDesign={vi.fn()}
      />,
    );
    // The root level resolves: stations + the compact "Your plan" preview node —
    // the epic itself is NOT a top-level node, only previewed inside the card.
    expect(await screen.findByText('Plan → your epics')).toBeTruthy();
    expect(await screen.findByText('Your plan')).toBeTruthy();
    expect(await screen.findByText('Billing epic')).toBeTruthy(); // inside the preview
    expect(document.querySelector('[data-node-id="__plan__"]')).not.toBeNull();
    expect(document.querySelector('[data-node-id="plan"]')).not.toBeNull();
    expect(document.querySelector('[data-node-id="e1"]')).toBeNull(); // not yet drilled
    expect(screen.getByPlaceholderText('Search the roadmap')).toBeTruthy();
    // The station serpentine is `flow`, not blocked-by deps → no dependency legend.
    expect(screen.queryByTestId('edge-legend')).toBeNull();

    // Drilling the preview reveals the real epic root node.
    fireEvent.keyDown(document.querySelector('[data-node-id="__plan__"]')!, { key: 'Enter' });
    expect(await screen.findByText('Billing epic')).toBeTruthy();
    expect(document.querySelector('[data-node-id="e1"]')).not.toBeNull();
  });

  it('without a projectKey, no roadmap is read and only the stations show', async () => {
    renderWithIntl(
      <OnboardingCanvas state={hubState()} idea="x" onOpen={vi.fn()} onOpenDesign={vi.fn()} />,
    );
    expect(await screen.findByText('Plan → your epics')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Search the roadmap')).toBeNull();
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      String(c[0]),
    );
    expect(calls.some((u) => u.includes('/roadmap'))).toBe(false);
  });
});
