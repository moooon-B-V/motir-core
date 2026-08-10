// @vitest-environment happy-dom
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// Every page in the documentation area titles ITSELF (Bug MOTIR-2526, under
// MOTIR-2315).
//
// ── The defect ──────────────────────────────────────────────────────────────
// `layout.tsx` held the only `generateMetadata` in the tree, so six of the seven
// pages published **"Motir API reference"** as their `<title>` and the API
// reference's description as their own — in the browser tab, in search results,
// in a shared link's preview and to a screen reader on arrival. It shipped that
// way because it was true when every page in the area WAS the API reference.
//
// ── What these cases hold ───────────────────────────────────────────────────
// The per-page assertions below would pass for six pages that each invented
// their own format, and the structural one would pass for a page that inherits.
// So there are three kinds of case here and each catches what the others cannot:
//
//   1. every page RESOLVES its own catalog keys (the fix, page by page);
//   2. every page module EXPORTS `generateMetadata` (the gap a page added
//      tomorrow would otherwise fall into, silently);
//   3. the titles follow ONE pattern (six correct-but-unrelated titles is the
//      same inconsistency wearing a nicer costume).
//
// `getTranslations` is stubbed to return the KEY, as the sibling suites do, so
// case 1 asserts the WIRING; the catalog values themselves are asserted in
// case 3 against `en`/`zh` directly.
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));

const DOCS_ROOT = join(process.cwd(), 'app', '(public)', 'docs');

/** Every `page.tsx` under the docs tree, as a route path. */
function docsPageFiles(dir = DOCS_ROOT): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry.startsWith('_')) continue;
      found.push(...docsPageFiles(full));
    } else if (entry === 'page.tsx') {
      found.push(full);
    }
  }
  return found;
}

/** `<root>/mcp/tools/page.tsx` → `/docs/mcp/tools`. */
function routeOf(file: string): string {
  const rel = relative(DOCS_ROOT, file).replace(/\/?page\.tsx$/, '');
  return rel ? `/docs/${rel}` : '/docs';
}

const PAGES: ReadonlyArray<{
  route: string;
  module: string;
  titleKey: string;
  descriptionKey: string;
}> = [
  {
    route: '/docs/api',
    module: '@/app/(public)/docs/api/page',
    titleKey: 'metaTitleReference',
    descriptionKey: 'metaDescriptionReference',
  },
  {
    route: '/docs/api/getting-started',
    module: '@/app/(public)/docs/api/getting-started/page',
    titleKey: 'metaTitleGuide',
    descriptionKey: 'metaDescriptionGuide',
  },
  {
    route: '/docs/api/stability',
    module: '@/app/(public)/docs/api/stability/page',
    titleKey: 'metaTitleStability',
    descriptionKey: 'metaDescriptionStability',
  },
  {
    route: '/docs/sandbox',
    module: '@/app/(public)/docs/sandbox/page',
    titleKey: 'metaTitleSandbox',
    descriptionKey: 'metaDescriptionSandbox',
  },
  {
    route: '/docs/cli',
    module: '@/app/(public)/docs/cli/page',
    titleKey: 'metaTitleCli',
    descriptionKey: 'metaDescriptionCli',
  },
  {
    route: '/docs/mcp',
    module: '@/app/(public)/docs/mcp/page',
    titleKey: 'metaTitleMcp',
    descriptionKey: 'metaDescriptionMcp',
  },
  {
    route: '/docs/mcp/tools',
    module: '@/app/(public)/docs/mcp/tools/page',
    titleKey: 'metaTitleMcpTools',
    descriptionKey: 'metaDescriptionMcpTools',
  },
];

describe('every documentation page titles itself', () => {
  it.each(PAGES.map((page) => [page.route, page] as const))(
    '%s resolves its own title and description',
    async (_route, page) => {
      const mod = (await import(page.module)) as {
        generateMetadata?: () => Promise<{ title?: unknown; description?: unknown }>;
      };
      expect(typeof mod.generateMetadata).toBe('function');
      expect(await mod.generateMetadata!()).toEqual({
        title: page.titleKey,
        description: page.descriptionKey,
      });
    },
  );

  it('leaves no page inheriting the area default', () => {
    // The AREA ROOT is the deliberate exemption: `/docs` IS the area, so the
    // shell's metadata is already its own. Every other page owes one, and a page
    // added without one shows up HERE rather than in a search result.
    const inheriting = docsPageFiles()
      .filter((file) => routeOf(file) !== '/docs')
      .filter(
        (file) =>
          !/export\s+(const|async function|function)\s+generateMetadata/.test(
            readFileSync(file, 'utf8'),
          ),
      );

    expect(inheriting.map(routeOf)).toEqual([]);
  });

  it('covers every page the tree serves, so this list cannot silently fall behind', () => {
    const served = docsPageFiles()
      .map(routeOf)
      .filter((route) => route !== '/docs')
      .sort();
    expect(PAGES.map((page) => page.route).sort()).toEqual(served);
  });
});

describe('the titles follow one pattern', () => {
  const titleKeys = PAGES.map((page) => page.titleKey);

  it.each(titleKeys)('%s ends with the area suffix in en', (key) => {
    expect((en.apiDocs as Record<string, string>)[key]).toMatch(/ · Motir docs$/);
  });

  it.each([
    ['metaTitleGuide', 'API reference'],
    ['metaTitleStability', 'API reference'],
    ['metaTitleMcpTools', 'MCP server'],
  ] as const)('%s names its surface, because the page is not one', (key, surface) => {
    // `<page> · <surface> · Motir docs` — the middle segment appears exactly
    // when the page sits INSIDE a surface rather than being one.
    expect((en.apiDocs as Record<string, string>)[key]).toContain(` · ${surface} · `);
  });

  it.each(['metaTitleReference', 'metaTitleSandbox', 'metaTitleCli', 'metaTitleMcp'] as const)(
    '%s is two segments, because the page IS the surface',
    (key) => {
      expect(String((en.apiDocs as Record<string, string>)[key]).split(' · ')).toHaveLength(2);
    },
  );

  it('gives the area default the AREA identity, not the API reference the tree used to inherit', () => {
    expect(en.apiDocs.metaTitle).toBe('Motir documentation');
    expect(en.apiDocs.metaTitle).not.toContain('API');
    expect(zh.apiDocs.metaTitle).not.toContain('API');
  });

  it('carries every title and description in BOTH catalogs', () => {
    for (const page of PAGES) {
      for (const key of [page.titleKey, page.descriptionKey]) {
        expect(en.apiDocs).toHaveProperty(key);
        expect(zh.apiDocs).toHaveProperty(key);
      }
    }
  });
});
