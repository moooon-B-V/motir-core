import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import robots from '../../app/robots';
import {
  AUTH_SEGMENTS,
  SIGNED_IN_SEGMENTS,
  buildRobots,
  disallowedPaths,
} from '../../lib/robotsPolicy';
import { topLevelSegments } from '../helpers/twoFactorGuardSweeps';

// MOTIR-3726 — `app.motir.co/robots.txt` returned 404 (Next's HTML not-found
// page, measured with a Googlebot UA) while the sitemap, JSON-LD, canonicals
// and OG cards had all shipped.
//
// ⚠️ THE FAILURE MODE OF A ROBOTS FILE IS SILENTLY DE-INDEXING THE SURFACE IT
// WAS MEANT TO HELP, so this file guards the ALLOW at least as hard as the
// deny. A robots.txt that over-blocks produces no error, no red check and no
// symptom until traffic disappears weeks later.

const APP = join(process.cwd(), 'app');
const SIGNED_IN_GROUPS = ['(authed)', '(onboarding)', '(planning)'] as const;

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
  it('allows the whole public reading surface', () => {
    const denied = disallowedPaths();
    for (const path of [
      '/',
      '/explore',
      '/explore/topic/design',
      '/docs',
      '/docs/api',
      '/legal',
      '/legal/privacy',
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

  it('disallows every signed-in segment the filesystem serves — derived, not remembered', () => {
    // The measurement `proxy-matcher.test.ts` exists because a hand-kept list
    // drifted: sixteen segments, three listed. The same guard, one surface over.
    const served = new Set<string>();
    for (const group of SIGNED_IN_GROUPS) {
      for (const segment of topLevelSegments(APP, group)) served.add(segment);
    }
    const authored = new Set<string>(SIGNED_IN_SEGMENTS);
    expect([...served].sort().filter((s) => !authored.has(s))).toEqual([]);
    expect([...authored].sort().filter((s) => !served.has(s))).toEqual([]);
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
