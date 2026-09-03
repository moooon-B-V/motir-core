import { describe, expect, it } from 'vitest';
import robots from '../../app/robots';
import {
  AUTH_SEGMENTS,
  SIGNED_IN_SEGMENTS,
  buildRobots,
  disallowedPaths,
} from '../../lib/robotsPolicy';

// MOTIR-3726 — `app.motir.co/robots.txt` returned 404 (Next's HTML not-found
// page, measured with a Googlebot UA) while the sitemap, JSON-LD, canonicals
// and OG cards had all shipped.
//
// ⚠️ THE FAILURE MODE OF A ROBOTS FILE IS SILENTLY DE-INDEXING THE SURFACE IT
// WAS MEANT TO HELP, so this file guards the ALLOW at least as hard as the
// deny. A robots.txt that over-blocks produces no error, no red check and no
// symptom until traffic disappears weeks later.

describe('robots policy', () => {
  it('serves a body with the sitemap and host of the resolved origin', () => {
    const result = buildRobots('https://example.test');
    expect(result.sitemap).toBe('https://example.test/sitemap.xml');
    expect(result.host).toBe('https://example.test');
  });

  it('renders through the route with no argument', () => {
    const result = robots();
    expect(result.sitemap).toMatch(/\/sitemap\.xml$/);
    expect(Array.isArray(result.rules) ? result.rules : [result.rules]).toHaveLength(1);
  });

  // ── the ALLOW half ───────────────────────────────────────────────────────
  //
  // ⚠️ `/legal` AND `/legal/privacy` WERE HERE AND ARE NOT ANY MORE (MOTIR-4103).
  // They came off because this application stopped having an opinion about them
  // at all: `content/legal/` and `app/(public)/legal/` are deleted, the seven
  // documents are served from `motir.co`, and what is left on this host is a
  // 404 before the cutover and `proxy.ts`'s 308 after it. A robots policy that
  // still promised those two addresses were crawlable HERE was asserting
  // something about a surface this repository no longer has.
  //
  // The four entries below that are in the SAME state — `/explore`, `/docs`,
  // `/p/*` and `/` — are deliberately left, and the difference is worth being
  // explicit about because it is not obvious. MOTIR-3951 deleted their pages
  // from this application too, so none of them RENDERS here either; they stay
  // because they are the paths `PUBLIC_REDIRECT_SEGMENTS` 308s onto `motir.co`,
  // and a `Disallow` on this host would stop a crawler ever following that
  // redirect to the page that does render. `/legal` is 308'd by that same set,
  // so it would qualify on that reading — this card's own acceptance criterion
  // is what takes it out, and the criterion is right for the narrower reason
  // that nothing in this repository can now say what is at that address.
  it('allows the whole public reading surface', () => {
    const denied = disallowedPaths();
    for (const path of [
      '/',
      '/explore',
      '/explore/topic/design',
      '/docs',
      '/docs/api',
      '/p/ACME',
      '/p/ACME/roadmap',
    ]) {
      expect(
        denied.some((d) => path === d || path.startsWith(d.endsWith('/') ? d : `${d}/`)),
        `${path} must stay crawlable`,
      ).toBe(false);
    }
  });

  it('does NOT disallow the ?rank= facets — they are self-canonical indexable states', () => {
    // `app/(public)/explore/(square)/page.tsx` builds `alternates.canonical`
    // from the query it was handed, so `?rank=popular` canonicalises to
    // ITSELF, and `app/sitemap.ts` lists it as its own entry. A Disallow here
    // would contradict both.
    expect(disallowedPaths().some((d) => d.includes('rank'))).toBe(false);
    expect(disallowedPaths()).not.toContain('/explore');
  });

  // ── the DENY half ────────────────────────────────────────────────────────
  it('disallows the API and every auth surface', () => {
    const denied = disallowedPaths();
    expect(denied).toContain('/api/');
    for (const segment of AUTH_SEGMENTS) expect(denied).toContain(`/${segment}`);
  });

  it('publishes every authored signed-in segment as a Disallow — nothing is declared and dropped', () => {
    // The list is compared to the FILESYSTEM in
    // `tests/seo/robots-signed-in-coverage.test.ts`, which walks the signed-in
    // route groups and therefore lives in the structural-guard lane. This half
    // is the other end of the same promise, and the reason that guard's textual
    // reading is worth anything: a segment in `SIGNED_IN_SEGMENTS` reaches the
    // served body.
    const denied = disallowedPaths();
    for (const segment of SIGNED_IN_SEGMENTS) expect(denied).toContain(`/${segment}`);
    const body = JSON.stringify(buildRobots('https://example.test'));
    for (const segment of SIGNED_IN_SEGMENTS) expect(body).toContain(`/${segment}`);
  });

  // ── the one deliberate NON-entry ─────────────────────────────────────────
  it('never names /admin — robots.txt is world-readable and the area 404s by design', () => {
    // `docs/decisions/platform-staff-auth.md` §2 (MOTIR-2896): the platform
    // staff area answers 404 rather than 403 so an anonymous request cannot
    // prove it exists. Publishing it in robots.txt would undo exactly that.
    const body = JSON.stringify(buildRobots('https://example.test'));
    expect(body).not.toContain('admin');
  });
});
