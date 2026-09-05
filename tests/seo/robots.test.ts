import { describe, expect, it } from 'vitest';
import robots, { dynamic } from '../../app/robots';
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
  it('serves a body with the host of the resolved origin and NO sitemap', () => {
    // ⚠️ MOTIR-4583. This assertion used to read
    // `expect(result.sitemap).toBe('https://example.test/sitemap.xml')`, and it
    // is inverted rather than relaxed. `app/sitemap.ts` answered that address
    // with an empty `<urlset>`, which the sitemaps schema does not permit, so
    // Search Console reported a PERMANENT error on a signal that was meant to
    // say "nothing to crawl". The route is deleted and the directive with it;
    // `tests/seo/sitemapAbsent.test.ts` carries the full reasoning and asserts
    // both halves of the absence.
    const result = buildRobots('https://example.test');
    expect(result.sitemap).toBeUndefined();
    expect(result.host).toBe('https://example.test');
  });

  it('renders through the route with no argument', () => {
    const result = robots();
    expect(result.sitemap).toBeUndefined();
    expect(result.host).toMatch(/^https?:\/\//);
    expect(Array.isArray(result.rules) ? result.rules : [result.rules]).toHaveLength(1);
  });

  // ── the RENDERING MODE ───────────────────────────────────────────────────
  //
  // ⚠️ MOTIR-4580 — THE ONE FACT ABOUT THIS ROUTE THAT NO ASSERTION ABOUT ITS
  // BODY CAN REACH, which is why every test above was green while production
  // served `Host: http://localhost:3000` for the life of the image.
  //
  // Without `force-dynamic` Next prerenders this route during `next build`, and
  // the `builder` stage has no `MOTIR_BASE_URL` (the Dockerfile declares no
  // `ARG` for it, on purpose). `resolveBaseUrlTrimmed()` therefore took
  // `lib/baseUrl.ts`'s rung 2 and the loopback origin was BAKED into the served
  // body. Fly secrets are runtime-only; nothing re-evaluated it afterwards.
  //
  // The tests above cannot see any of that, and not through any fault of
  // theirs: they inject the origin (`buildRobots('https://example.test')`),
  // which is the correct shape for a POLICY test and leaves the RESOLUTION path
  // unexercised. Static-vs-dynamic is a rendering-mode fact rather than a policy
  // fact, so the guard has to assert the rendering mode itself. This assertion
  // fails on the commit before the fix and passes after it.
  it('declares force-dynamic — the origin is resolved at REQUEST time, never baked at build', () => {
    expect(dynamic).toBe('force-dynamic');
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

  it('does not DISALLOW /legal either — the case that replaced the two removed above', () => {
    // ⚠️ MOTIR-4104. The two entries the comment above describes came OFF the
    // allow list and nothing took their place, which left the policy with no
    // recorded opinion about `/legal` at all — and "no opinion" and "we checked,
    // and the answer is nothing" are the same empty diff.
    //
    // What replaced them is this: `/legal` must stay OUT of the disallow set.
    // `proxy.ts`'s `PUBLIC_REDIRECT_SEGMENTS` holds `legal`, so the address 308s
    // onto `motir.co/legal`, and a `Disallow` on this host would stop a crawler
    // ever following that redirect to the page that does render — the exact
    // reasoning that keeps `/explore`, `/docs`, `/p/*` and `/` on the allow list.
    // What it must NOT do is claim `/legal` is a crawlable surface HERE, because
    // nothing in this repository serves one any more (`content/legal/` and
    // `app/(public)/legal/` are deleted).
    //
    // So the assertion is two-sided, and both sides are the point: absent from
    // the deny set, and absent from the served body. The failure mode of a
    // robots file is silently de-indexing the surface it was meant to help, and
    // adding `/legal` to `SIGNED_IN_SEGMENTS` or `AUTH_SEGMENTS` by reflex — it
    // is neither — would do exactly that to a document set we publish.
    const denied = disallowedPaths();
    expect(
      denied.some((d) => '/legal' === d || '/legal'.startsWith(d.endsWith('/') ? d : `${d}/`)),
      '/legal must not be disallowed — it 308s to motir.co/legal',
    ).toBe(false);
    expect(JSON.stringify(buildRobots('https://example.test'))).not.toContain('/legal');
  });

  it('does NOT disallow the ?rank= facets — they are self-canonical indexable states', () => {
    // `app/(public)/explore/(square)/page.tsx` builds `alternates.canonical`
    // from the query it was handed, so `?rank=popular` canonicalises to
    // ITSELF. A Disallow here would contradict that canonical, and would stop a
    // crawler following the 308 to the page that renders on `motir.co`. (This
    // comment used to add "and `app/sitemap.ts` lists it as its own entry" —
    // that sitemap emptied with MOTIR-3951 and is deleted outright by
    // MOTIR-4583, so the canonical is the whole of the reason now.)
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
