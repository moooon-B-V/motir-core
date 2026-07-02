// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { DiscoveryOnboarding } from '@/components/onboarding/DiscoveryOnboarding';
import type { PreplanStateDTO } from '@/lib/dto/aiPreplan';

// MOTIR-1487 — the onboarding step tracker must NOT flash the FIRST step
// ("Understanding your project" / "you are here") on a resume before the persisted
// current step hydrates. The current step is read async from motir-ai
// (`GET /api/ai/pre-plan`) AFTER mount; before it lands the loop holds its
// fresh-state default (discovery = "you are here"). The shell must show a
// "Resuming…" placeholder until the read settles, then land on the real step.
//
// This is the reproduce-first test (the card's mandate): with the pre-plan read
// held in flight, it asserts the tracker never shows step 1 as current during
// load — it was RED before the fix (the hub painted discovery as "you are here").

// The Server Action the shell fires on mount to clear the preserved-idea cookie
// — `'use server'` + next/headers, unusable (and irrelevant) in a unit render.
vi.mock('@/app/(onboarding)/onboarding/actions', () => ({
  clearPendingIdeaAction: vi.fn(),
}));

const HERE = 'You are here'; // onboarding.chat.canvas.pills.here
const RESUMING = 'Resuming…'; // onboarding.chat.resuming
const DISCOVERY_LABEL = 'Understanding your project'; // the FIRST step's station label

const artifact = (kind: PreplanStateDTO['docs'][number]['kind']) => ({
  kind,
  currentBody: `# ${kind}\n\nbody`,
  currentVersion: 1,
  summary: [],
  versions: [],
});

// A resume mid-journey: the loop has produced discovery → vision → feasibility and
// sits on the HUB (currentGate not parked at a review), so the canvas step tracker
// should land with "you are here" on feasibility (step 3), never discovery (step 1).
const RESUME_DTO: PreplanStateDTO = {
  session: {
    classification: 'startup',
    platform: 'web',
    designStarter: null,
    designChoice: null,
    validationTiming: null,
    docSkipSet: [],
    currentGate: null,
    status: 'active',
    conversation: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  },
  docs: [artifact('discovery'), artifact('vision'), artifact('feasibility')],
  catalog: null,
};

const okJson = (body: unknown) => ({ ok: true, json: async () => body });

let resolvePreplan: (res: unknown) => void;
let preplanPending: Promise<unknown>;

/** Route each fetch the shell makes; pre-plan is held until the test resolves it. */
function stubFetch(preplan: 'pending' | unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const u = String(url);
      if (u.includes('/api/ai/pre-plan')) {
        return preplan === 'pending' ? preplanPending : Promise.resolve(preplan);
      }
      if (u.includes('/api/canvas-layout')) {
        return Promise.resolve(okJson({ layout: { positions: [] } }));
      }
      if (u.includes('/api/ai/access')) return Promise.resolve({ ok: false });
      return Promise.resolve(okJson({}));
    }),
  );
}

beforeEach(() => {
  preplanPending = new Promise((r) => {
    resolvePreplan = r;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DiscoveryOnboarding — resume hydration (MOTIR-1487)', () => {
  it('shows "Resuming…" (never step-1 "you are here") until the persisted step loads, then lands on step N', async () => {
    stubFetch('pending');
    renderWithIntl(<DiscoveryOnboarding initialIdea={null} />);

    // While the pre-plan read is in flight: the "Resuming…" placeholder shows and
    // the step tracker is NOT painted — no first-step flash.
    expect(await screen.findByText(RESUMING)).toBeTruthy();
    expect(screen.queryByText(HERE)).toBeNull();
    expect(screen.queryByText(DISCOVERY_LABEL)).toBeNull();

    // The persisted session lands (feasibility, step 3).
    await act(async () => {
      resolvePreplan(okJson(RESUME_DTO));
      await preplanPending;
    });

    // The placeholder clears and the canvas paints the CORRECT current step.
    await waitFor(() => expect(screen.queryByText(RESUMING)).toBeNull());
    await screen.findByText(HERE);
    const feasibility = document.querySelector('[data-node-id="feasibility"]');
    const discovery = document.querySelector('[data-node-id="discovery"]');
    expect(feasibility?.textContent).toContain(HERE); // step N is "you are here"
    expect(discovery?.textContent).not.toContain(HERE); // step 1 never is
  });

  it('a FRESH visit (arrives with the preserved idea) paints step 1 immediately — no "Resuming…" placeholder', async () => {
    // A fresh start carries the idea cookie and discovery genuinely IS the current
    // step, so there is no wrong-step flash to hide — render the canvas at once.
    stubFetch('pending');
    renderWithIntl(<DiscoveryOnboarding initialIdea="An invoicing app" />);

    expect(screen.queryByText(RESUMING)).toBeNull();
    await screen.findByText(HERE);
    const discovery = document.querySelector('[data-node-id="discovery"]');
    expect(discovery?.textContent).toContain(HERE); // step 1 IS current on a fresh start
  });
});
