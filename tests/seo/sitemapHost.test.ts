import { describe, expect, it } from 'vitest';

// MOTIR-3951 — the sitemap's surface moved, so the sitemap empties.
//
// `app/sitemap.ts` used to build an entry for every crawlable public surface
// (`/explore` + its rank variants, `/explore/topic/<slug>`, `/p/<identifier>`
// and its tabs), and MOTIR-3881 asserted the whole list stayed HOST-SCOPED
// (built from the application origin, never the public origin). Those pages
// moved to `motir.co` — which publishes its own sitemap for what IT serves —
// so this host's sitemap now answers 200 with no `<url>` rather than
// advertising URLs that 404 or 301 off-host.
//
// The test re-points rather than disappears. The contract it now pins is the
// state that prevents BOTH failures the old assertions guarded against: a stale
// sitemap handing a crawler the brand host's URLs (the cross-submission 3881
// was written against), and a sitemap indexing routes this host no longer
// serves (the 404-ing-URL failure 3951's deletion would otherwise introduce).

const { default: sitemap } = await import('@/app/sitemap');

describe('app/sitemap.ts lists nothing now that the public surface moved', () => {
  it('returns an empty urlset', async () => {
    const entries = await sitemap();
    expect(entries).toEqual([]);
  });
});
