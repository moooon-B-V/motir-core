import { describe, expect, it } from 'vitest';
import { DOCS_REDIRECTS } from '../../next.config';

// The `/api-docs` -> `/docs` redirect map (MOTIR-2286 · ADR
// `public-api-conventions.md` Amendment 9 Q1).
//
// ── Why a test at all, for three lines of config ────────────────────────────
// The area was renamed one day after it shipped, on the argument that a URL is a
// promise to strangers. That argument only holds if the old addresses keep
// working, and the failure mode is silent: a redirect deleted in a later refactor
// breaks nothing any other test renders, and nobody notices until an external
// link 404s. The map is small enough to assert exactly, so it is asserted
// exactly.
//
// It reads the EXPORT rather than calling `redirects()` through the built config,
// because `next.config.ts` runs `withNextIntl` and seeds placeholder OAuth
// environment variables at module load — machinery this assertion does not need
// and should not depend on. The config's own `redirects()` returns this array
// verbatim, so there is nothing between the two to drift.

describe('the documentation area keeps every address it ever served', () => {
  it('redirects every old-and-root path, permanently', () => {
    expect([...DOCS_REDIRECTS]).toEqual([
      {
        source: '/api-docs/getting-started',
        destination: '/docs/api/getting-started',
        permanent: true,
      },
      { source: '/api-docs/stability', destination: '/docs/api/stability', permanent: true },
      { source: '/api-docs', destination: '/docs/api', permanent: true },
      { source: '/api-docs/:path*', destination: '/docs/:path*', permanent: true },
      {
        source: '/docs/getting-started',
        destination: '/docs/api/getting-started',
        permanent: true,
      },
      { source: '/docs/stability', destination: '/docs/api/stability', permanent: true },
      { source: '/docs', destination: '/docs/api', permanent: true },
    ]);
  });

  it('sends the TWO addresses Amendment 11 moved to their new homes', () => {
    // The guide and the policy moved inside the reference's prefix
    // (`/docs/getting-started` → `/docs/api/getting-started`). Both of their
    // previous addresses — the `/docs/*` one and the older `/api-docs/*` one —
    // must land on the new page, or two generations of links break at once.
    const dest = (source: string) =>
      DOCS_REDIRECTS.find((rule) => rule.source === source)?.destination;

    expect(dest('/docs/getting-started')).toBe('/docs/api/getting-started');
    expect(dest('/docs/stability')).toBe('/docs/api/stability');
    expect(dest('/api-docs/getting-started')).toBe('/docs/api/getting-started');
    expect(dest('/api-docs/stability')).toBe('/docs/api/stability');
  });

  it('resolves every old `/api-docs/*` page in ONE hop, not two', () => {
    // `/api-docs/:path*` maps to `/docs/:path*`, and `/docs/getting-started` is
    // itself now a redirect — so without an exact rule ahead of the wildcard an
    // old bookmark would chain. Assert no destination is itself a source.
    const sources = new Set<string>(DOCS_REDIRECTS.map((rule) => rule.source));
    const chained = DOCS_REDIRECTS.filter(
      (rule) => !rule.source.includes(':path') && sources.has(rule.destination),
    );
    expect(chained).toEqual([]);
  });

  it('sends the bare `/api-docs` to the REFERENCE, not to the area root', () => {
    // The reference deliberately does not own `/docs` (Amendment 9 Q1: a
    // four-page area whose root is one of the four cannot grow a fifth without
    // re-opening the argument). So the old reference URL must land on the
    // reference itself — sending it to `/docs` would cost a second hop and,
    // until the third rule existed, a 404.
    const exact = DOCS_REDIRECTS.find((rule) => rule.source === '/api-docs');
    expect(exact?.destination).toBe('/docs/api');
  });

  it('declares EVERY exact `/api-docs/*` rule before the wildcard, which also matches empty', () => {
    // `/api-docs/:path*` matches `/api-docs` and `/api-docs/stability` alike, so
    // ordering is what decides where each lands. Next matches top-to-bottom, and
    // a rule appended after the wildcard is dead code that reads as live.
    const sources = DOCS_REDIRECTS.map((rule) => rule.source);
    const wildcard = sources.indexOf('/api-docs/:path*');
    for (const exact of sources.filter(
      (source) => source.startsWith('/api-docs') && !source.includes(':path'),
    )) {
      expect(sources.indexOf(exact)).toBeLessThan(wildcard);
    }
  });

  it('is permanent on every rule — a 307 would keep crawlers on the old address', () => {
    expect(DOCS_REDIRECTS.every((rule) => rule.permanent)).toBe(true);
  });
});
