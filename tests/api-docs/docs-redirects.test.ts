import { describe, expect, it } from 'vitest';
import { DOCS_REDIRECTS } from '../../next.config';

// The `/api-docs` -> `/docs` redirect map (MOTIR-2286 · ADR
// `public-api-conventions.md` Amendment 8 Q1).
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
  it('redirects the three old-and-root paths, permanently', () => {
    expect([...DOCS_REDIRECTS]).toEqual([
      { source: '/api-docs', destination: '/docs/api', permanent: true },
      { source: '/api-docs/:path*', destination: '/docs/:path*', permanent: true },
      { source: '/docs', destination: '/docs/api', permanent: true },
    ]);
  });

  it('sends the bare `/api-docs` to the REFERENCE, not to the area root', () => {
    // The reference deliberately does not own `/docs` (Amendment 8 Q1: a
    // four-page area whose root is one of the four cannot grow a fifth without
    // re-opening the argument). So the old reference URL must land on the
    // reference itself — sending it to `/docs` would cost a second hop and,
    // until the third rule existed, a 404.
    const exact = DOCS_REDIRECTS.find((rule) => rule.source === '/api-docs');
    expect(exact?.destination).toBe('/docs/api');
  });

  it('declares the exact rule BEFORE the wildcard, which also matches empty', () => {
    // `/api-docs/:path*` matches `/api-docs` too, so ordering is what decides
    // where the bare path lands. Next matches top-to-bottom.
    const sources = DOCS_REDIRECTS.map((rule) => rule.source);
    expect(sources.indexOf('/api-docs')).toBeLessThan(sources.indexOf('/api-docs/:path*'));
  });

  it('is permanent on every rule — a 307 would keep crawlers on the old address', () => {
    expect(DOCS_REDIRECTS.every((rule) => rule.permanent)).toBe(true);
  });
});
