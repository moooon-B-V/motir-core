// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { OnboardingCanvas } from '@/components/onboarding/OnboardingCanvas';
import { type DiscoveryState, initialDiscoveryState } from '@/lib/onboarding/discoveryLoop';

// The onboarding canvas shows the WHOLE project: when the active project already
// has a produced work-item tree (read from `/api/projects/[key]/roadmap`), the
// epics hang under the plan station — drilling "Plan → your epics" reveals them.

function hubState(): DiscoveryState {
  return {
    ...initialDiscoveryState(),
    producedKinds: ['discovery', 'vision'],
    activeKind: 'vision',
    session: { ...initialDiscoveryState().session, classification: 'startup', platform: 'web' },
  };
}

const roadmap = {
  nodes: [
    {
      id: 'e1',
      parentId: null,
      kind: 'epic',
      identifier: 'MOTIR-10',
      title: 'Billing epic',
      status: 'todo',
      isDone: false,
      children: [],
    },
  ],
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).includes('/roadmap')) {
        return { ok: true, json: async () => roadmap };
      }
      return { ok: true, json: async () => ({ layout: { positions: [] } }) };
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('OnboardingCanvas — produced work-item tree', () => {
  it('shows the produced epics at the top level beside the stations', async () => {
    renderWithIntl(
      <OnboardingCanvas
        state={hubState()}
        idea="x"
        projectKey="MOTIR"
        onOpen={vi.fn()}
        onOpenDesign={vi.fn()}
      />,
    );
    // Stations paint after the layout load…
    expect(await screen.findByText('Plan → your epics')).toBeTruthy();
    // …and once the roadmap read resolves, the epic is VISIBLE at the top level
    // (a root beside the stations) — not hidden behind a drill. The canvas is now
    // searchable too.
    expect(await screen.findByText('Billing epic')).toBeTruthy();
    expect(document.querySelector('[data-node-id="e1"]')).not.toBeNull();
    expect(document.querySelector('[data-node-id="plan"]')).not.toBeNull();
    expect(screen.getByPlaceholderText('Search the roadmap')).toBeTruthy();
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
