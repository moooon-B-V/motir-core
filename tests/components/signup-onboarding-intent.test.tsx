// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import enMessages from '@/messages/en.json';

// MOTIR-4402 — `/sign-up` is where the sign-in card's "Plan with AI" door now
// LANDS, so it is the surface that has to acknowledge the intent it is carrying.
//
// The defect this closes was on `/sign-in`, and the reason it went unnoticed for
// so long is that a carried intent with no visible acknowledgement is
// indistinguishable from no intent at all: the reader pressed a button with
// their own intention written on it and got back a screen that said nothing
// about it. Moving the door without giving its destination the same
// acknowledgement would reproduce the defect one surface over.
//
// Renders the CARD, not the route: `page.tsx` is a server shell (MOTIR-3372).

let searchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => searchParams,
}));

vi.mock('@/lib/auth/client', () => ({ signUp: { email: vi.fn() } }));

import { SignUpCard } from '@/app/(auth)/sign-up/_components/SignUpCard';
import { ONBOARDING_ENTRY_PATH, resolvePostAuthDestination } from '@/lib/navigation/landing';

const AUTH = enMessages.auth;

beforeEach(() => {
  searchParams = new URLSearchParams();
});

afterEach(() => {
  cleanup();
});

describe('/sign-up carrying an onboarding intent (MOTIR-4402)', () => {
  it('says where the reader is headed when arriving from the Plan-with-AI door', () => {
    searchParams = new URLSearchParams({ next: ONBOARDING_ENTRY_PATH });

    renderWithIntl(<SignUpCard legal={null} />);

    expect(screen.getByText(AUTH.onboardingCarriedLabel)).toBeTruthy();
    expect(screen.getByText(AUTH.onboardingCarriedSignUp)).toBeTruthy();
    // The account-creation form is still the thing being asked for — the banner
    // sits above it, it does not replace it.
    expect(screen.getByRole('heading', { name: AUTH.welcomeToMotir })).toBeTruthy();
  });

  it('resolves that arrival to the entrance through the ONE owner of the destination', () => {
    // AC2 — completing sign-up lands on the onboarding entrance, and the
    // destination is computed by `resolvePostAuthDestination` rather than by a
    // second `/onboarding` literal on this card.
    expect(resolvePostAuthDestination({ next: ONBOARDING_ENTRY_PATH })).toBe(ONBOARDING_ENTRY_PATH);
  });

  it('renders exactly as it did before for every other arrival', () => {
    // AC5 — absent, empty, unrecognised, and a route that merely starts with the
    // same characters.
    for (const params of [
      new URLSearchParams(),
      new URLSearchParams({ next: '' }),
      new URLSearchParams({ next: '/items' }),
      new URLSearchParams({ next: '/onboardingsomething' }),
    ]) {
      searchParams = params;
      const { unmount } = renderWithIntl(<SignUpCard legal={null} />);

      expect(screen.queryByText(AUTH.onboardingCarriedSignUp)).toBeNull();
      expect(screen.getByRole('heading', { name: AUTH.welcomeToMotir })).toBeTruthy();
      unmount();
    }
  });

  it('does not read an OFF-ORIGIN next as an onboarding intent', () => {
    // AC6 — the banner keys off the SANITIZED destination, so a hostile value is
    // already gone by the time this card asks. Reading the raw param would light
    // the banner up for `//onboarding`.
    for (const hostile of ['//onboarding', 'https://evil.example/onboarding', '/\\onboarding']) {
      searchParams = new URLSearchParams({ next: hostile });
      const { unmount } = renderWithIntl(<SignUpCard legal={null} />);

      expect(screen.queryByText(AUTH.onboardingCarriedSignUp), hostile).toBeNull();
      unmount();
    }
  });
});
