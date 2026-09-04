// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import enMessages from '@/messages/en.json';

// Subtask 7.22.1 / MOTIR-1457 — the "Plan with AI" onboarding door on the login
// surface. A visitor with no account enters the start-fresh AI planning flow
// from here (the front-door role the relocated marketing hero used to hold).
//
// ⚠️ AND ITS DESTINATION CHANGED (MOTIR-4402). It used to link to `/onboarding`,
// which is AUTHENTICATED: the layout bounced the signed-out visitor straight
// back to `/sign-in?next=/onboarding`, and this card rendered that return
// identically to the arrival. The only reader who could see the control was the
// one it round-tripped (`page.tsx` sends a signed-in reader away unless
// `?draft=` is present), so there was no reader for whom the door worked. It now
// targets account creation, carrying the intent in `?next=` — and the card that
// is already SERVING that intent says so and stops re-offering the door.
//
// It renders the CARD rather than the route: MOTIR-3372 made `page.tsx` an async
// server shell that resolves the session first, and the door this test is about
// lives in the client island the shell renders.

const replace = vi.fn();
let searchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace, prefetch: vi.fn() }),
  useSearchParams: () => searchParams,
}));

// The sign-in form imports the Better-Auth client; stub the piece it calls so the
// component renders in a plain jsdom-less env without real auth wiring.
vi.mock('@/lib/auth/client', () => ({ signIn: { email: vi.fn() } }));

import { SignInCard } from '@/app/(auth)/sign-in/_components/SignInCard';
import { ONBOARDING_ENTRY_PATH } from '@/lib/navigation/landing';

const AUTH = enMessages.auth;

beforeEach(() => {
  searchParams = new URLSearchParams();
  replace.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('sign-in "Plan with AI" door (7.22.1 · MOTIR-4402)', () => {
  it('sends a visitor with no account to SIGN-UP, carrying the onboarding intent', () => {
    renderWithIntl(<SignInCard />);

    const link = screen.getByRole('link', { name: /plan with ai/i });
    const href = link.getAttribute('href')!;

    // AC1 — the destination is a DIFFERENT surface from the one they left. The
    // defect was a door whose only observable effect was a query string.
    expect(href.startsWith('/sign-up')).toBe(true);
    expect(href.startsWith('/sign-in')).toBe(false);
    // AC2 — the intent rides in `?next=`, the carrier both auth surfaces already
    // honour and sanitize. No second carrier was introduced.
    expect(new URL(href, 'https://app.motir.co').searchParams.get('next')).toBe(
      ONBOARDING_ENTRY_PATH,
    );
  });

  it('is NOT re-offered on the arrival it is already serving, which says so instead', () => {
    // The bounce `app/(onboarding)/layout.tsx` performs, verbatim.
    searchParams = new URLSearchParams({ next: ONBOARDING_ENTRY_PATH });

    renderWithIntl(<SignInCard />);

    // AC4 — the copy acknowledges the intent…
    expect(screen.getByText(AUTH.onboardingCarriedLabel)).toBeTruthy();
    expect(screen.getByText(AUTH.onboardingCarriedSignIn)).toBeTruthy();
    // …and the door onto the surface the reader is standing on is gone, along
    // with its lead. Re-offering it is what made the original loop read as a
    // working control.
    expect(screen.queryByRole('link', { name: /plan with ai/i })).toBeNull();
    expect(screen.queryByText(AUTH.planWithAiLead)).toBeNull();
  });

  it('says so for a DEEPER onboarding destination too, not only the bare entrance', () => {
    searchParams = new URLSearchParams({ next: `${ONBOARDING_ENTRY_PATH}/discovery` });

    renderWithIntl(<SignInCard />);

    expect(screen.getByText(AUTH.onboardingCarriedSignIn)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /plan with ai/i })).toBeNull();
  });

  it('leaves an ABSENT, EMPTY or UNRECOGNISED next exactly as it was', () => {
    // AC5 — three arrivals that carry no onboarding intent. Each renders the
    // door and none of them claims to be carrying anything.
    for (const params of [
      new URLSearchParams(),
      new URLSearchParams({ next: '' }),
      new URLSearchParams({ next: '/items' }),
      // `/onboardingsomething` is a DIFFERENT route — a prefix match would
      // wrongly suppress the door here.
      new URLSearchParams({ next: '/onboardingsomething' }),
    ]) {
      searchParams = params;
      const { unmount } = renderWithIntl(<SignInCard />);

      expect(screen.getByRole('link', { name: /plan with ai/i })).toBeTruthy();
      expect(screen.queryByText(AUTH.onboardingCarriedSignIn)).toBeNull();
      unmount();
    }
  });

  it('does not treat an OFF-ORIGIN next as an onboarding intent — no open redirect', () => {
    // AC6 — `sanitizeNextPath` rejects these inside `resolvePostAuthDestination`,
    // so the resolved destination is the default landing and the card renders as
    // it always did. A card that read the RAW param would show the banner here.
    for (const hostile of ['//onboarding', 'https://evil.example/onboarding']) {
      searchParams = new URLSearchParams({ next: hostile });
      const { unmount } = renderWithIntl(<SignInCard />);

      expect(screen.queryByText(AUTH.onboardingCarriedSignIn)).toBeNull();
      expect(screen.getByRole('link', { name: /plan with ai/i })).toBeTruthy();
      unmount();
    }
  });
});

describe('the ?draft= arrival is UNCHANGED (MOTIR-1458 · MOTIR-3372)', () => {
  it('is ALSO an onboarding intent for a signed-out reader — idea shown, door not re-offered', async () => {
    // `resolvePostAuthDestination` sends a carried draft to the entrance, so this
    // arrival is serving the same intent as `next=/onboarding` and gets the same
    // treatment. Before MOTIR-4402 it offered a door that would have bounced the
    // reader back to this exact page.
    searchParams = new URLSearchParams({ draft: 'draft-abc' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ idea: 'An idea' }) }),
    );

    renderWithIntl(<SignInCard />);

    await waitFor(() => expect(screen.getByText('An idea')).toBeTruthy());
    expect(screen.getByText(AUTH.onboardingCarriedSignIn)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /plan with ai/i })).toBeNull();
    // Signed OUT — the card stays put and lets them authenticate.
    expect(replace).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('still sends a signed-in reader straight to the entrance, idea intact', async () => {
    // AC3 — the one case a signed-in reader renders on this page. The claim POST
    // plants the pending-idea cookie, the banner shows what survived, and the
    // card then navigates on itself. None of that is touched by MOTIR-4402.
    searchParams = new URLSearchParams({ draft: 'draft-abc' });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ idea: 'A tracker that plans itself' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithIntl(<SignInCard sessionActive />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith(ONBOARDING_ENTRY_PATH));
    expect(fetchMock).toHaveBeenCalledWith('/api/idea-draft/draft-abc/claim', { method: 'POST' });
    expect(screen.getByText('A tracker that plans itself')).toBeTruthy();

    vi.unstubAllGlobals();
  });
});
