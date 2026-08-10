// @vitest-environment happy-dom
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import { DOCS_REDIRECTS } from '../../next.config';

// STORY GATE — MOTIR-2315, the `/docs` index (Subtask MOTIR-2524).
//
// The per-card suites each prove their own deliverable. This one asserts the
// properties that live BETWEEN them, which is where every defect in this area
// has actually been: four call sites handing the rail an operation list
// (MOTIR-2307), seven pages inheriting one title (MOTIR-2526), and now two
// renderers that must agree about what Motir documents.
//
// ── Coverage, measured rather than assumed ──────────────────────────────────
// The story's three new files — `app/(public)/docs/page.tsx`,
// `lib/apiDocs/surfaces.ts`, `lib/apiDocs/pageMetadata.ts` — are added to
// `vitest.config.ts`'s coverage `include` AND its per-file `thresholds` by this
// subtask, so the ≥90% gate now applies to them. Measured on the merged branch
// they were already at the floor from the feature cards' own units, so this file
// writes no top-up tests: that is the expected normal this gate resolves at run
// time, not a finding.
//
// What it writes instead is below, and none of it is reachable from one card.

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));

afterEach(() => {
  cleanup();
  vi.doUnmock('@/lib/apiDocs/surfaces');
  vi.resetModules();
});

const ROOT = process.cwd();

/** `/docs/mcp/tools` → does `app/(public)/docs/mcp/tools/page.tsx` exist? */
function routeIsServed(route: string): boolean {
  const rest = route.replace(/^\/docs\/?/, '');
  return existsSync(join(ROOT, 'app', '(public)', 'docs', rest, 'page.tsx'));
}

async function renderIndex() {
  const { default: DocsIndexPage } = await import('@/app/(public)/docs/page');
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      {await DocsIndexPage()}
    </NextIntlClientProvider>,
  );
}

async function renderRail() {
  const { CatalogueNav } = await import('@/app/(public)/docs/_components/CatalogueNav');
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <CatalogueNav current="sandbox" />
    </NextIntlClientProvider>,
  );
}

/** Every surface href the current render exposes, in DOM order. */
function surfaceHrefs(within: HTMLElement | Document = document): string[] {
  return [...within.querySelectorAll('a[href^="/docs"]')]
    .map((a) => a.getAttribute('href') ?? '')
    .filter((href) => /^\/docs\/[a-z-]+$/.test(href));
}

describe('the two renderers of the surface list cannot disagree', () => {
  // ── THE TRUTH TEST ────────────────────────────────────────────────────────
  // Amendment 19 Q3 put the surface list in ONE module because the rail and the
  // index both show it, and two hand-maintained lists of one fact drift with
  // nothing failing: a fifth surface gets added to whichever file its author
  // opened, both renderers keep rendering, and the front door is quietly
  // incomplete.
  //
  // ⚠️ Asserting "both render four rows" would pass for two hardcoded lists that
  // happen to agree today — the exact defect this is meant to exclude. So the
  // module is REPLACED with a five-surface list and both renderers are asked
  // again: only a renderer that actually derives can show the fifth. That makes
  // this a test of DERIVATION, not of agreement.
  const FIVE = [
    {
      key: 'reference',
      route: '/docs/api',
      labelKey: 'navReference',
      descriptionKey: 'surfaceReferenceDesc',
    },
    {
      key: 'sandbox',
      route: '/docs/sandbox',
      labelKey: 'navSandbox',
      descriptionKey: 'surfaceSandboxDesc',
    },
    { key: 'cli', route: '/docs/cli', labelKey: 'navCli', descriptionKey: 'surfaceCliDesc' },
    { key: 'mcp', route: '/docs/mcp', labelKey: 'navMcp', descriptionKey: 'surfaceMcpDesc' },
    // The surface that does not exist. If either renderer restates the list,
    // this row appears in one and not the other — which is the drift itself.
    {
      key: 'selfHosting',
      route: '/docs/self-hosting',
      labelKey: 'navSandbox',
      descriptionKey: 'surfaceSandboxDesc',
    },
  ];

  beforeEach(() => {
    vi.resetModules();
  });

  it('shows the SAME surfaces, in the same order, on the index and in the rail', async () => {
    const { DOC_SURFACES } = await import('@/lib/apiDocs/surfaces');
    const expected = DOC_SURFACES.map((surface) => surface.route);

    await renderIndex();
    expect(surfaceHrefs()).toEqual(expected);
    cleanup();

    await renderRail();
    expect(surfaceHrefs()).toEqual(expected);
  });

  it('carries a FIFTH surface into BOTH renderers with no edit to either', async () => {
    vi.doMock('@/lib/apiDocs/surfaces', () => ({
      DOC_SURFACES: FIVE,
      DOC_SURFACE_ROUTES: Object.fromEntries(FIVE.map((s) => [s.key, s.route])),
    }));

    await renderIndex();
    expect(surfaceHrefs()).toContain('/docs/self-hosting');
    expect(surfaceHrefs()).toHaveLength(5);
    cleanup();

    await renderRail();
    expect(surfaceHrefs()).toContain('/docs/self-hosting');
    expect(surfaceHrefs()).toHaveLength(5);
  });
});

describe('every address this story publishes resolves', () => {
  it('links only routes the app actually serves, from the index', async () => {
    await renderIndex();
    const unserved = surfaceHrefs().filter((route) => !routeIsServed(route));
    expect(unserved).toEqual([]);
  });

  it('lands every redirect on an address that resolves', () => {
    // A rule pointing at a page that no longer exists is a 308 into a 404 — and
    // nothing else in the suite reads the map against the route tree.
    const dead = DOCS_REDIRECTS.filter((rule) => !rule.destination.includes(':path')).filter(
      (rule) => !routeIsServed(rule.destination),
    );
    expect(dead).toEqual([]);
  });

  it('leaves no page in the area unreachable from the index or its rail', async () => {
    // Reachability, from the reader's seat: the four surfaces are on the index,
    // and every page INSIDE a surface is one tier-2 row away. The one page that
    // is neither is the index itself.
    const { DOC_SURFACES } = await import('@/lib/apiDocs/surfaces');
    const surfaceRoutes = new Set(DOC_SURFACES.map((surface) => surface.route));

    const { subAreaFor } = await import('@/app/(public)/docs/_components/CatalogueNav');
    const inSecondTier = new Set(
      (['gettingStarted', 'stability', 'mcpTools'] as const).flatMap((page) =>
        subAreaFor(page) ? [page] : [],
      ),
    );
    expect(inSecondTier.size).toBe(3);

    for (const route of surfaceRoutes) expect(routeIsServed(route)).toBe(true);
  });
});

describe('the guards this story leaned on are still whole', () => {
  it('keeps the redirect map asserted EXACTLY, not by membership', () => {
    // The map is the area's promise to strangers across two renames. Loosening
    // its assertion to a `toContain` would let a rule vanish silently, which is
    // the failure that guard exists for — so the SHAPE of the assertion is
    // itself worth holding.
    const spec = readFileSync(join(ROOT, 'tests/api-docs/docs-redirects.test.ts'), 'utf8');
    expect(spec).toContain('expect([...DOCS_REDIRECTS]).toEqual([');
    expect(spec).not.toContain('toContain({ source');
  });

  it('keeps the index OUT of the API sub-area, so the prefix rule still decides', async () => {
    // Amendment 11 Q2: the operation index renders iff the route is `/docs/api`
    // or below. The index is at `/docs`, so it cannot acquire operation rows —
    // and that must stay a consequence of the PREFIX, never a special case.
    const { isInApiArea } = await import('@/app/(public)/docs/_components/CatalogueNav');
    expect(isInApiArea('reference')).toBe(true);
    expect(isInApiArea('gettingStarted')).toBe(true);
    expect(isInApiArea('stability')).toBe(true);
    expect(isInApiArea('sandbox')).toBe(false);
    expect(isInApiArea('cli')).toBe(false);
    expect(isInApiArea('mcp')).toBe(false);
    expect(isInApiArea('mcpTools')).toBe(false);
  });

  it('holds every string this story shipped in BOTH catalogs', async () => {
    const { DOC_SURFACES } = await import('@/lib/apiDocs/surfaces');
    const keys = [
      'indexTitle',
      'indexLede',
      'metaTitle',
      'metaDescription',
      ...DOC_SURFACES.flatMap((surface) => [surface.labelKey, surface.descriptionKey]),
    ];
    for (const key of keys) {
      expect(en.apiDocs, `en is missing ${key}`).toHaveProperty(key);
      expect(zh.apiDocs, `zh is missing ${key}`).toHaveProperty(key);
    }
    expect(Object.keys(en.apiDocs).sort()).toEqual(Object.keys(zh.apiDocs).sort());
    expect(Object.keys(en.projectSquare).sort()).toEqual(Object.keys(zh.projectSquare).sort());
  });

  it('keeps the new route under the coverage gate, in both halves', () => {
    // A file outside `include` is invisible to the report, and a `thresholds`
    // key that reaches no file passes every percentage (MOTIR-2449). The glob
    // guard catches the second half; this catches a file being dropped from the
    // first, which is how a surface silently leaves the gate.
    const config = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8');
    for (const entry of [
      "'app/**/docs/page.tsx'",
      "'lib/apiDocs/surfaces.ts'",
      "'lib/apiDocs/pageMetadata.ts'",
    ]) {
      // once in `include`, once in `thresholds`
      expect(
        config.split(entry).length - 1,
        `${entry} is not in both halves`,
      ).toBeGreaterThanOrEqual(2);
    }
  });
});
