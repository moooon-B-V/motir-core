import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stripComments } from '../../helpers/v1RouteAudit';
import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { locales } from '@/lib/i18n/locales';
import {
  mcpToolCatalogueDocument,
  type McpLocalizedToolCatalogueDocument,
  type McpToolCatalogueDocument,
} from '@/lib/apiDocs/mcp';
import { MCP_SUMMARY_TRANSLATIONS } from '@/lib/apiDocs/mcpSummaryTranslations';
import { permissionSlug } from '@/lib/permissions/catalog';

// MOTIR-8038 — the coverage + integration gate for the localized MCP catalogue.
//
// `mcp-tools-locale.test.ts` proves the freshness RULE on fixtures; this file
// checks the ASSEMBLED catalogue — the shipped summary files, the shipped
// `messages/<locale>.json` + `messages/sources/<locale>.json` permission copy and
// the real route handler — so the one-off hand checks of the translation cards
// become a guard that survives every later English edit, new tool and new
// translation. In-process, no database, no server: the handler is a pure function
// of the URL over compile-time data.
//
// Staleness is NOT a failure here. A stale or missing entry falls back to English
// and the case-6 report lists it; blocking an English summary edit behind ten
// re-translations is the outcome the story rejects.
//
// `TOOL_SUMMARIES` is module-private, so "today's English summary" is read from
// the unlocalized document, which is built from it row for row.

const REPO_ROOT = process.cwd();
const ROUTE = join('app', 'api', 'docs', 'mcp-tools.json', 'route.ts');
const BASE = 'http://localhost:3000/api/docs/mcp-tools.json';
const NON_EN = locales.filter((l) => l !== 'en');

const english = mcpToolCatalogueDocument();
const englishSummary = new Map(
  english.groups.flatMap((g) => g.tools.map((t) => [t.name, t.summary] as const)),
);
const toolNames: string[] = Object.keys(TOOL_PERMISSIONS).sort();

type LocaleDoc = McpLocalizedToolCatalogueDocument;
const localized = (l: string): LocaleDoc => mcpToolCatalogueDocument(l) as LocaleDoc;

function readJson<T>(...parts: string[]): T {
  return JSON.parse(readFileSync(join(REPO_ROOT, ...parts), 'utf8')) as T;
}
const enMessages = readJson<{
  permissions: Record<string, { label: string; description: string }>;
}>('messages', 'en.json');

async function get(query: string, headers?: Record<string, string>): Promise<Response> {
  const { GET } = await import('@/app/api/docs/mcp-tools.json/route');
  return GET(new Request(`${BASE}${query}`, { headers }));
}

const codeSpans = (text: string): string[] => (text.match(/`[^`]*`/g) ?? []).sort();
const count = (text: string, needle: string): number => text.split(needle).length - 1;

afterEach(() => {
  vi.doUnmock('@/lib/apiDocs/mcpSummaryTranslations');
  vi.resetModules();
});

describe('population — every tool, every group, every locale', () => {
  it('walks ten non-English locales and a real catalogue', () => {
    expect(NON_EN.length).toBeGreaterThanOrEqual(10);
    expect(toolNames.length).toBeGreaterThan(50);
  });

  it.each(NON_EN)('1. %s serves exactly the registry tool set, in the same groups', (l) => {
    const doc = localized(l);
    const served: string[] = doc.groups.flatMap((g) => g.tools.map((t) => t.name));
    const wanted = new Set(toolNames);
    expect({
      missing: toolNames.filter((n) => !served.includes(n)),
      unexpected: served.filter((n) => !wanted.has(n)).sort(),
    }).toEqual({ missing: [], unexpected: [] });
    expect(doc.groups.map((g) => g.permission)).toEqual(english.groups.map((g) => g.permission));
    expect(doc.toolCount).toBe(served.length);
  });

  it.each(NON_EN)('2. %s differs from English only in the human text', (l) => {
    const doc = localized(l);
    expect(doc.endpoint).toBe(english.endpoint);
    expect(doc.toolCount).toBe(english.toolCount);
    for (const [i, g] of doc.groups.entries()) {
      const e = english.groups[i]!;
      expect([g.permission, g.grantedByDefault]).toEqual([e.permission, e.grantedByDefault]);
      expect(g.tools.map((t) => t.name)).toEqual(e.tools.map((t) => t.name));
      for (const [j, t] of g.tools.entries()) {
        const et = e.tools[j]!;
        expect([t.permission, t.inputSchema, t.title, t.annotations]).toEqual([
          et.permission,
          et.inputSchema,
          et.title,
          et.annotations,
        ]);
      }
    }
  });

  it.each(NON_EN)('3. %s labels every row with its own locale or en', (l) => {
    const doc = localized(l);
    expect(doc.locale).toBe(l);
    for (const g of doc.groups) {
      expect([l, 'en']).toContain(g.textLocale);
      for (const t of g.tools) expect([l, 'en']).toContain(t.summaryLocale);
    }
  });
});

describe('the served partition matches the shipped data', () => {
  it.each(NON_EN)('4. %s: summaryLocale is the locale iff the entry is current', (l) => {
    const entries = MCP_SUMMARY_TRANSLATIONS[l as keyof typeof MCP_SUMMARY_TRANSLATIONS];
    for (const g of localized(l).groups) {
      for (const t of g.tools) {
        const en = englishSummary.get(t.name)!;
        const entry = (entries as Record<string, { summary: string; source: string } | undefined>)[
          t.name
        ];
        const current = entry !== undefined && entry.source === en;
        expect(t.summaryLocale, `${l}/${t.name}`).toBe(current ? l : 'en');
        expect(t.summary, `${l}/${t.name}`).toBe(current ? entry!.summary : en);
      }
    }
  });

  it.each(NON_EN)(
    '5. %s: a group is translated iff both keys exist and both sources are current',
    (l) => {
      const copy = readJson<{
        permissions: Record<string, { label?: string; description?: string }>;
      }>('messages', `${l}.json`).permissions;
      const sources = readJson<Record<string, string>>('messages', 'sources', `${l}.json`);
      for (const g of localized(l).groups) {
        const slug = permissionSlug(g.permission);
        const en = enMessages.permissions[slug]!;
        const c = copy[slug];
        const current =
          typeof c?.label === 'string' &&
          typeof c?.description === 'string' &&
          sources[`permissions.${slug}.label`] === en.label &&
          sources[`permissions.${slug}.description`] === en.description;
        expect(g.textLocale, `${l}/${slug}`).toBe(current ? l : 'en');
        expect([g.label, g.gates], `${l}/${slug}`).toEqual(
          current ? [c!.label, c!.description] : [en.label, en.description],
        );
      }
    },
  );

  it('6. reports what is served translated and what is English (a report, never a failure)', () => {
    const lines: string[] = [];
    for (const l of NON_EN) {
      const doc = localized(l);
      const tools = doc.groups.flatMap((g) => g.tools);
      const englishTools = tools.filter((t) => t.summaryLocale === 'en').map((t) => t.name);
      const groupsL = doc.groups.filter((g) => g.textLocale === l).length;
      lines.push(
        `${l}: tools ${tools.length - englishTools.length}/${tools.length} in ${l}, groups ${groupsL}/${doc.groups.length} in ${l}` +
          (englishTools.length > 0 ? `; English tools: ${englishTools.join(', ')}` : ''),
      );
    }
    console.warn(`MCP catalogue coverage\n${lines.join('\n')}`);
    expect(lines).toHaveLength(NON_EN.length);
  });
});

describe('per-entry integrity of the shipped translations', () => {
  const files = NON_EN.flatMap((l) =>
    Object.entries(
      MCP_SUMMARY_TRANSLATIONS[l as keyof typeof MCP_SUMMARY_TRANSLATIONS] as Record<
        string,
        { summary: string; source: string }
      >,
    ).map(([name, entry]) => ({ l, name, ...entry })),
  );

  it('walks real entries', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('7. every entry keeps its inline-code spans, as a multiset', () => {
    const bad = files.filter(
      (e) => codeSpans(e.summary).join('\u0000') !== codeSpans(e.source).join('\u0000'),
    );
    expect(bad.map((e) => `${e.l}/${e.name}`)).toEqual([]);
  });

  // At this base no English summary names the product, so the predicate is also
  // driven over a fixture below: a guard that cannot be shown to fire proves nothing.
  const dropsBrand = (e: { summary: string; source: string }): boolean =>
    count(e.summary, 'Motir AI') < count(e.source, 'Motir AI') ||
    count(e.summary, 'Motir') < count(e.source, 'Motir');

  it('8. every entry keeps Motir / Motir AI untranslated', () => {
    expect(files.filter(dropsBrand).map((e) => `${e.l}/${e.name}`)).toEqual([]);
  });

  it('8b. the brand check fires on a fixture that translates the name', () => {
    const source = 'Ask Motir AI, then tell Motir.';
    expect(dropsBrand({ source, summary: 'Frag Motir AI, dann sag es Motir.' })).toBe(false);
    expect(dropsBrand({ source, summary: 'Frag Motor AI, dann sag es Motir.' })).toBe(true);
    expect(dropsBrand({ source, summary: 'Frag Motir AI, dann sag es dem Produkt.' })).toBe(true);
  });

  it('9. every key of every locale file names a tool', () => {
    const known = new Set(toolNames);
    expect(files.filter((e) => !known.has(e.name)).map((e) => `${e.l}/${e.name}`)).toEqual([]);
  });
});

describe('10. an English edit after translation falls back per tool (fixture over the shipped files)', () => {
  async function build(alter: boolean, target: string): Promise<Record<string, LocaleDoc>> {
    vi.resetModules();
    if (alter) {
      const real = await vi.importActual<{
        MCP_SUMMARY_TRANSLATIONS: Record<
          string,
          Record<string, { summary: string; source: string }>
        >;
      }>('@/lib/apiDocs/mcpSummaryTranslations');
      const map = Object.fromEntries(
        Object.entries(real.MCP_SUMMARY_TRANSLATIONS).map(([l, entries]) => [
          l,
          Object.fromEntries(
            Object.entries(entries).map(([name, e]) => [
              name,
              name === target ? { ...e, source: `${e.source} (edited)` } : e,
            ]),
          ),
        ]),
      );
      vi.doMock('@/lib/apiDocs/mcpSummaryTranslations', () => ({ MCP_SUMMARY_TRANSLATIONS: map }));
    }
    const mod = await import('@/lib/apiDocs/mcp');
    return Object.fromEntries(NON_EN.map((l) => [l, mod.mcpToolCatalogueDocument(l) as LocaleDoc]));
  }

  it('serves that one tool in English in all locales and leaves every other tool alone', async () => {
    const baseline = await build(false, '');
    const target = toolNames.find((n) =>
      NON_EN.every(
        (l) =>
          baseline[l]!.groups.flatMap((g) => g.tools).find((t) => t.name === n)!.summaryLocale ===
          l,
      ),
    );
    if (target === undefined) return; // no tool is current in every locale at this base
    const edited = await build(true, target);
    for (const l of NON_EN) {
      const before = baseline[l]!.groups.flatMap((g) => g.tools);
      const after = edited[l]!.groups.flatMap((g) => g.tools);
      for (const [i, t] of after.entries()) {
        if (t.name === target) {
          expect([t.summaryLocale, t.summary], `${l}/${t.name}`).toEqual([
            'en',
            englishSummary.get(t.name),
          ]);
        } else {
          expect([t.summaryLocale, t.summary], `${l}/${t.name}`).toEqual([
            before[i]!.summaryLocale,
            before[i]!.summary,
          ]);
        }
      }
    }
  });
});

describe('unknown locale and the unlocalized shape (through the real handler)', () => {
  it('11. every non-locale value serves the unlocalized bytes, with no new field and no echo', async () => {
    const base = await get('');
    const baseBody = await base.text();
    expect(base.status).toBe(200);
    expect(Object.keys(JSON.parse(baseBody) as McpToolCatalogueDocument).sort()).toEqual([
      'endpoint',
      'groups',
      'toolCount',
    ]);
    expect(baseBody).not.toMatch(/"(locale|textLocale|summaryLocale)"/);
    for (const q of [
      '?locale=en',
      '?locale=xx',
      '?locale=',
      '?locale=JA',
      '?locale=ja-JP',
      '?locale=%3Cscript%3E',
      '?locale=../../etc',
    ]) {
      const res = await get(q);
      expect(await res.text(), q).toBe(baseBody);
      expect(res.status, q).toBe(200);
      expect(res.headers.get('content-type'), q).toBe(base.headers.get('content-type'));
      expect(res.headers.get('cache-control'), q).toBe(base.headers.get('cache-control'));
    }
    expect(baseBody).not.toContain('<script>');
    expect(baseBody).not.toContain('../../etc');
  });

  it.each(NON_EN)('12. ?locale=%s serves the built document, the same bytes twice', async (l) => {
    const first = await get(`?locale=${l}`);
    expect(first.status).toBe(200);
    const body = await first.text();
    expect(body).toBe(JSON.stringify(mcpToolCatalogueDocument(l)));
    expect(await (await get(`?locale=${l}`)).text()).toBe(body);
  });

  it('13. a repeated locale parameter reads the first value only', async () => {
    expect(await (await get('?locale=ja&locale=ko')).text()).toBe(
      await (await get('?locale=ja')).text(),
    );
  });
});

describe('the route safety properties, restated for the locale parameter', () => {
  const route = stripComments(readFileSync(join(REPO_ROOT, ROUTE), 'utf8'));

  it('14. reads only searchParams.get(locale), imports only the content module, and authenticates nothing', () => {
    expect([...route.matchAll(/searchParams\.get\(([^)]*)\)/g)].map((m) => m[1])).toEqual([
      "'locale'",
    ]);
    expect(route).not.toMatch(
      /\.headers|cookies\(|headers\(|\.json\(\)|\.text\(\)|\.formData\(|request\.body|req\.body/,
    );
    expect([...route.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort()).toEqual([
      '@/lib/apiDocs/mcp',
      'next/server',
    ]);
    expect(route).not.toMatch(
      /@\/lib\/db|Repository|Service\b|withV1Route|withMcpAuth|getSession|consumeRateLimit/,
    );
  });

  it('15. the locale leaf and the translation files import nothing that reaches the registry or the database', () => {
    const dir = join(REPO_ROOT, 'lib', 'apiDocs', 'mcpSummaryTranslations');
    const files = [
      join(REPO_ROOT, 'lib', 'apiDocs', 'mcpCatalogueLocale.ts'),
      ...readdirSync(dir).map((f) => join(dir, f)),
    ];
    for (const file of files) {
      const text = stripComments(readFileSync(file, 'utf8'));
      for (const m of text.matchAll(/^import (type )?[^;]*?from '([^']+)'/gm)) {
        const isType = m[1] !== undefined;
        const from = m[2]!;
        if (!isType) expect(from, file).not.toMatch(/lib\/mcp\//);
        expect(from, file).not.toMatch(/^@\/lib\/db$|^@prisma\/client$|^node:crypto$|^next-intl/);
      }
    }
  });

  it.each(['', '?locale=ko'])('16. nothing per-caller reaches the response (%s)', async (q) => {
    const plain = await (await get(q)).text();
    const withCreds = await (
      await get(q, { authorization: 'Bearer garbage', cookie: 'session=abc; other=1' })
    ).text();
    expect(withCreds).toBe(plain);
  });
});
