import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import { DOC_SURFACES, DOC_SURFACE_ROUTES } from '@/lib/apiDocs/surfaces';

// The shared surface list (Subtask MOTIR-2522, under MOTIR-2315 · ADR
// `public-api-conventions.md` Amendment 19 Q3).
//
// This module is read by TWO renderers — the docs rail's first tier and the
// `/docs` index — so an entry that names a route the app does not serve, or a
// catalog key that does not resolve, breaks a page rather than this file. The
// cases below are the cheap ones that can be answered without rendering either.
//
// The cross-renderer property itself — that the rail and the index show the SAME
// set — belongs to the story's vitest gate (MOTIR-2524), which can render both.

const APP_DOCS_ROOT = join(process.cwd(), 'app', '(public)', 'docs');

/** `/docs/api` → `app/(public)/docs/api/page.tsx`. */
function pageFileFor(route: string): string {
  const relative = route.replace(/^\/docs\/?/, '');
  return join(APP_DOCS_ROOT, relative, 'page.tsx');
}

describe('the documented surface list', () => {
  it('is non-empty and free of duplicate keys and routes', () => {
    expect(DOC_SURFACES.length).toBeGreaterThan(0);

    const keys = DOC_SURFACES.map((surface) => surface.key);
    const routes = DOC_SURFACES.map((surface) => surface.route);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it('covers the four surfaces the area serves today, in the shipped rail order', () => {
    // Amendment 19 Q2 keeps the rail's order deliberately: the list is shared,
    // so re-ordering it re-orders the navigation of every page in the area.
    expect(DOC_SURFACES.map((surface) => surface.key)).toEqual([
      'reference',
      'sandbox',
      'cli',
      'mcp',
    ]);
  });

  it.each(DOC_SURFACES.map((surface) => [surface.key, surface.route] as const))(
    'points %s at a route the app actually serves (%s)',
    (_key, route) => {
      // A surface's route is where a reader LANDS. An entry naming a route with
      // no page file renders a link into a 404 on both renderers at once.
      expect(existsSync(pageFileFor(route))).toBe(true);
    },
  );

  it.each(DOC_SURFACES.map((surface) => [surface.key, surface] as const))(
    'resolves both catalog keys for %s, in en AND zh',
    (_key, surface) => {
      // A key present in one catalog and absent from the other renders a raw
      // identifier to half the product's readers, so both are asserted here.
      for (const catalogKey of [surface.labelKey, surface.descriptionKey]) {
        expect(en.apiDocs).toHaveProperty(catalogKey);
        expect(zh.apiDocs).toHaveProperty(catalogKey);
        expect(String((en.apiDocs as Record<string, string>)[catalogKey])).not.toHaveLength(0);
        expect(String((zh.apiDocs as Record<string, string>)[catalogKey])).not.toHaveLength(0);
      }
    },
  );

  it('derives the route map from the list rather than restating it', () => {
    expect(DOC_SURFACE_ROUTES).toEqual(
      Object.fromEntries(DOC_SURFACES.map((surface) => [surface.key, surface.route])),
    );
  });

  it('carries the index page chrome in both catalogs', () => {
    // The index's own strings ship with this card even though the page that
    // renders them is MOTIR-2523's — the page adds no key of its own.
    //
    // Its `<title>` is NOT here: MOTIR-2526 retargeted the area default
    // (`metaTitle` / `metaDescription`, read by the layout) from the API
    // reference's words to the AREA's, and the index IS the area — so it
    // inherits them, and a second pair saying the same thing was deleted rather
    // than kept in step by hand. `docs-page-metadata.test.ts` exempts exactly
    // this one route for exactly this reason.
    for (const key of ['indexTitle', 'indexLede']) {
      expect(en.apiDocs).toHaveProperty(key);
      expect(zh.apiDocs).toHaveProperty(key);
    }
  });

  it('keeps the two catalogs at the same apiDocs key set', () => {
    expect(Object.keys(en.apiDocs).sort()).toEqual(Object.keys(zh.apiDocs).sort());
  });
});
