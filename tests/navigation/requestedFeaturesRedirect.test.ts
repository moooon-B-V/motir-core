import { describe, expect, it } from 'vitest';
import nextConfig, { REQUESTED_FEATURES_REDIRECTS } from '../../next.config';

// MOTIR-6772 — the members' inbox moved from `/triage` to `/requested-features`
// when "triage" retired as a name (`docs/decisions/public-request-board-retired.md`
// Decision 4). The old address is a bookmark, so it must keep landing: a
// permanent (308) redirect composed into `redirects()`, which Next runs BEFORE
// `proxy.ts` — so a signed-out browser gets the same redirect a signed-in one
// does, and only then meets the session bounce at the new address. The browser
// half of that claim is `tests/e2e/triage-flow.spec.ts`.

describe('the /triage → /requested-features redirect', () => {
  it('is one permanent rule from the old address to the new one', () => {
    expect(REQUESTED_FEATURES_REDIRECTS).toEqual([
      { source: '/triage', destination: '/requested-features', permanent: true },
    ]);
  });

  it('is composed into the redirects Next actually serves', async () => {
    const served = await nextConfig.redirects!();
    expect(served).toContainEqual({
      source: '/triage',
      destination: '/requested-features',
      permanent: true,
    });
  });
});
