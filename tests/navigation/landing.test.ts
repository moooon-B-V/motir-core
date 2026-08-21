import { describe, expect, it } from 'vitest';
import {
  AUTHED_LANDING_PATH,
  ONBOARDING_ENTRY_PATH,
  resolvePostAuthDestination,
} from '@/lib/navigation/landing';

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
