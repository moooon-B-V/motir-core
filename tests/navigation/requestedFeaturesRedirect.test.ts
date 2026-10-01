import { describe, expect, it } from 'vitest';
import nextConfig, { REQUESTED_FEATURES_REDIRECTS } from '../../next.config';

// MOTIR-7043 — the members' inbox is Triage again, at `/triage`
// (`docs/decisions/public-request-board-retired.md` Decision 4, AMENDMENT 1).
// MOTIR-6772 had moved it to `/requested-features`, and that address is a
// bookmark now, so it must keep landing: a permanent (308) redirect composed into
// `redirects()`, which Next runs BEFORE `proxy.ts` — so a signed-out browser gets
// the same redirect a signed-in one does, and only then meets the session bounce
// at `/triage`. The browser half of that claim is `tests/e2e/triage-flow.spec.ts`.
//
// ⚠️ The rule that ran the OTHER way (`/triage` → `/requested-features`) must be
// gone: both at once would be a redirect loop.

describe('the /requested-features → /triage redirect', () => {
  it('is one permanent rule from the old address to the inbox', () => {
    expect(REQUESTED_FEATURES_REDIRECTS).toEqual([
      { source: '/requested-features', destination: '/triage', permanent: true },
    ]);
  });

  it('is composed into the redirects Next actually serves', async () => {
    const served = await nextConfig.redirects!();
    expect(served).toContainEqual({
      source: '/requested-features',
      destination: '/triage',
      permanent: true,
    });
  });

  it('no longer sends /triage anywhere — the inbox is served there', async () => {
    const served = await nextConfig.redirects!();
    expect(served.filter((rule) => rule.source === '/triage')).toEqual([]);
  });
});
