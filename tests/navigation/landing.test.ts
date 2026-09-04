import { describe, expect, it } from 'vitest';
import {
  AUTHED_LANDING_PATH,
  ONBOARDING_ENTRY_PATH,
  ONBOARDING_SIGNUP_DOOR_PATH,
  isOnboardingDestination,
  resolvePostAuthDestination,
} from '@/lib/navigation/landing';
import { sanitizeNextPath } from '@/lib/navigation/nextDestination';

// MOTIR-3373 — the resolver both credential surfaces and both server shells now
// share. The precedence used to be spelled out twice, nearly-but-not-exactly the
// same in each file (sign-in carried the `?draft=` branch, sign-up did not), and
// the shells added a third and fourth copy. This is the one behaviour test for
// it; the guard beside this file is what stops a fifth copy appearing.

describe('resolvePostAuthDestination (MOTIR-3373)', () => {
  it('defaults to the signed-in landing', () => {
    expect(resolvePostAuthDestination({})).toBe(AUTHED_LANDING_PATH);
    expect(resolvePostAuthDestination({ next: null, draftId: null })).toBe(AUTHED_LANDING_PATH);
  });

  it('sends a carried idea draft to onboarding, where the planted cookie is read', () => {
    expect(resolvePostAuthDestination({ draftId: 'draft-abc' })).toBe(ONBOARDING_ENTRY_PATH);
  });

  it('lets an explicit ?next= win over both — the CLI hand-off and every deep link', () => {
    expect(resolvePostAuthDestination({ next: '/device?user_code=ABCD-1234' })).toBe(
      '/device?user_code=ABCD-1234',
    );
    // Even against a draft: the caller asked for somewhere specific.
    expect(resolvePostAuthDestination({ next: '/items', draftId: 'draft-abc' })).toBe('/items');
  });

  it('refuses an off-origin ?next= and falls back — never an open redirect', () => {
    expect(resolvePostAuthDestination({ next: 'https://evil.example' })).toBe(AUTHED_LANDING_PATH);
    expect(resolvePostAuthDestination({ next: '//evil.example' })).toBe(AUTHED_LANDING_PATH);
    // The fallback still respects the draft branch.
    expect(resolvePostAuthDestination({ next: 'https://evil.example', draftId: 'd' })).toBe(
      ONBOARDING_ENTRY_PATH,
    );
  });

  it('accepts what `useSearchParams().get` actually returns — a string or null', () => {
    expect(resolvePostAuthDestination({ next: null })).toBe(AUTHED_LANDING_PATH);
    expect(resolvePostAuthDestination({ next: '/boards' })).toBe('/boards');
  });
});

// MOTIR-4402 — the two answers the credential surfaces needed and were spelling
// out for themselves: WHERE the "Plan with AI" door goes, and WHETHER the
// destination a card resolved is the onboarding entrance.

describe('ONBOARDING_SIGNUP_DOOR_PATH (MOTIR-4402)', () => {
  it('goes to account creation, not to the authenticated entrance', () => {
    // The whole defect in one assertion: the door used to point at
    // `ONBOARDING_ENTRY_PATH`, which bounces a reader with no session straight
    // back to the surface the door is ON.
    expect(ONBOARDING_SIGNUP_DOOR_PATH.startsWith('/sign-up?')).toBe(true);
    expect(ONBOARDING_SIGNUP_DOOR_PATH.startsWith(ONBOARDING_ENTRY_PATH)).toBe(false);
  });

  it('carries the intent in ?next=, and the value survives the sanitizer', () => {
    const next = new URL(ONBOARDING_SIGNUP_DOOR_PATH, 'https://app.motir.co').searchParams.get(
      'next',
    );
    expect(next).toBe(ONBOARDING_ENTRY_PATH);
    // The round trip that matters: `/sign-up` sanitizes before resolving, so a
    // door whose value the sanitizer rejected would silently land on /home.
    expect(sanitizeNextPath(next!)).toBe(ONBOARDING_ENTRY_PATH);
    expect(resolvePostAuthDestination({ next })).toBe(ONBOARDING_ENTRY_PATH);
  });

  it('is COMPOSED from the entrance constant, so there is no second literal', () => {
    expect(ONBOARDING_SIGNUP_DOOR_PATH).toBe(
      `/sign-up?next=${encodeURIComponent(ONBOARDING_ENTRY_PATH)}`,
    );
  });
});

describe('isOnboardingDestination (MOTIR-4402)', () => {
  it('recognises the entrance, a query on it, and a sub-path under it', () => {
    expect(isOnboardingDestination(ONBOARDING_ENTRY_PATH)).toBe(true);
    expect(isOnboardingDestination(`${ONBOARDING_ENTRY_PATH}?seed=1`)).toBe(true);
    expect(isOnboardingDestination(`${ONBOARDING_ENTRY_PATH}/discovery`)).toBe(true);
  });

  it('does NOT match a different route that merely starts the same way', () => {
    // A bare `startsWith` would claim this one, and suppressing the door on a
    // surface that is not serving the intent is the defect inverted.
    expect(isOnboardingDestination('/onboardingsomething')).toBe(false);
    expect(isOnboardingDestination('/onboardings')).toBe(false);
  });

  it('does not match the default landing or an unrelated deep link', () => {
    expect(isOnboardingDestination(AUTHED_LANDING_PATH)).toBe(false);
    expect(isOnboardingDestination('/device?user_code=ABCD-1234')).toBe(false);
  });

  it('answers on the RESOLVED destination, which is what makes it open-redirect-safe', () => {
    // Every hostile `next` resolves to the default landing first, so the
    // predicate never sees it. A caller that asked this about the RAW param
    // would answer `true` for `//onboarding`.
    for (const hostile of ['//onboarding', 'https://evil.example/onboarding', '/\\onboarding']) {
      expect(isOnboardingDestination(resolvePostAuthDestination({ next: hostile })), hostile).toBe(
        false,
      );
    }
  });

  it('is true for the ?draft= arrival, which resolves to the entrance', () => {
    expect(isOnboardingDestination(resolvePostAuthDestination({ draftId: 'draft-abc' }))).toBe(
      true,
    );
  });
});
