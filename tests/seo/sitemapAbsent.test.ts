import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRobots } from '../../lib/robotsPolicy';

// MOTIR-4583 — this application serves NO sitemap, and that is the fix rather
// than an omission.
//
// ── The history this file records, because the obvious repair is the bug ───
//
// MOTIR-3951 moved every crawlable public page to `motir.co`, so `app/sitemap.ts`
// was left returning `[]` and this file asserted the empty list. MOTIR-3881
// before it asserted the same list stayed HOST-scoped. Both were guarding real
// failures: a sitemap handing a crawler the brand host's URLs, and one indexing
// routes this host no longer serves.
//
// ⚠️ AN EMPTY `<urlset>` IS NOT A WAY TO SAY "NOTHING TO CRAWL". The sitemaps
// schema requires at least one `<url>`, so `[]` served as XML is three lines
// that Google can fetch and cannot accept:
//
//     <?xml version="1.0" encoding="UTF-8"?>
//     <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
//     </urlset>
//
// Search Console read that at `app.motir.co/sitemap.xml` and reported
// `Missing XML tag · Parent tag: urlset · Tag: url` at line 3 — permanently,
// because the condition producing it was the intended end state. The signal was
// authored with care and documented in a comment, and it was unreceivable by
// construction: there is no representation of *deliberately nothing* in that
// schema. *No sitemap* is the standard one, and it is what this host now serves.
//
// So the assertions below are STRICTLY STRONGER than the ones they replace, not
// a relaxation of them: a route that does not exist cannot advertise the brand
// host's URLs and cannot index a route this host no longer serves. Both earlier
// guarantees hold by construction rather than by assertion.
//
// The companion half is `lib/robotsPolicy.ts`, which must not advertise the
// address either — see MOTIR-4580, which this card blocks: a corrected
// `robots.txt` pointing at an invalid sitemap would let Google REDISCOVER the
// error on every crawl instead of once.

const ROOT = process.cwd();

/**
 * Every filesystem shape Next would serve `/sitemap.xml` from. A route file is
 * resolved from `app/` by CONVENTION, so its absence is a filesystem fact and
 * there is no module left to import and assert against.
 */
const SITEMAP_ROUTE_FILES = [
  'app/sitemap.ts',
  'app/sitemap.tsx',
  'app/sitemap.js',
  'app/sitemap.xml/route.ts',
  'app/sitemap.xml/route.tsx',
];

describe('app.motir.co serves no sitemap', () => {
  it('has no sitemap route in app/ — the address 404s rather than answering 200 with an empty urlset', () => {
    const present = SITEMAP_ROUTE_FILES.filter((path) => existsSync(join(ROOT, path)));
    expect(present, 'an empty <urlset> is schema-invalid; serve no sitemap instead').toEqual([]);
  });

  it('robots.txt advertises no sitemap — nothing may point a crawler back at the address', () => {
    const result = buildRobots('https://example.test');
    expect(result).not.toHaveProperty('sitemap');
    expect(JSON.stringify(result)).not.toContain('sitemap');
  });

  it('still emits the Host directive — dropping it is a cross-host decision this card does not take', () => {
    expect(buildRobots('https://example.test').host).toBe('https://example.test');
  });
});
