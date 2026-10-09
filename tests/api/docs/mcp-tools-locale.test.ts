import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  localizedGroupText,
  localizedSummary,
  resolveCatalogueLocale,
  type GroupTextDeps,
} from '@/lib/apiDocs/mcpCatalogueLocale';
import {
  mcpToolCatalogueDocument,
  mcpCatalogue,
  type McpLocalizedToolCatalogueDocument,
} from '@/lib/apiDocs/mcp';
import { locales } from '@/lib/i18n/locales';
import { MCP_SUMMARY_TRANSLATIONS } from '@/lib/apiDocs/mcpSummaryTranslations';
import { permissionSlug } from '@/lib/permissions/catalog';
import type { McpSummaryTranslations } from '@/lib/apiDocs/mcpSummaryTranslations/types';

// MOTIR-8031 — the per-locale published MCP catalogue. The rule is exercised on
// injected FIXTURE translations and records, never the shipped summary files, so it
// holds whatever the translation cards put in them.

const ROUTE_URL = 'http://localhost:3000/api/docs/mcp-tools.json';
const NON_EN = locales.filter((l) => l !== 'en');

const english = mcpToolCatalogueDocument();
const firstTool = english.groups[0]!.tools[0]!;
const firstGroup = english.groups[0]!;
const slug = permissionSlug(firstGroup.permission);

function emptyTranslations(): Record<(typeof NON_EN)[number], McpSummaryTranslations> {
  return Object.fromEntries(NON_EN.map((l) => [l, {}])) as never;
}

function groupDeps(copy: Record<string, unknown>, sources: Record<string, string>): GroupTextDeps {
  const blankCopy = Object.fromEntries(NON_EN.map((l) => [l, {}]));
  const blankSources = Object.fromEntries(NON_EN.map((l) => [l, {}]));
  return {
    copy: { ...blankCopy, ko: copy } as never,
    sources: { ...blankSources, ko: sources } as never,
  };
}

async function get(query: string): Promise<string> {
  const { GET } = await import('@/app/api/docs/mcp-tools.json/route');
  return (await GET(new Request(`${ROUTE_URL}${query}`))).text();
}

describe('resolveCatalogueLocale', () => {
  it('resolves the ten non-English codes and nothing else', () => {
    for (const l of NON_EN) expect(resolveCatalogueLocale(l)).toBe(l);
    for (const raw of ['en', 'xx', '', 'JA', ' ja', null, undefined]) {
      expect(resolveCatalogueLocale(raw)).toBeNull();
    }
  });
});

describe('the unlocalized request', () => {
  it("has exactly today's keys and no new field", () => {
    expect(Object.keys(english).sort()).toEqual(['endpoint', 'groups', 'toolCount']);
    for (const group of english.groups) {
      expect(Object.keys(group)).not.toContain('textLocale');
      for (const tool of group.tools) expect(Object.keys(tool)).not.toContain('summaryLocale');
    }
  });

  it('is byte-identical for en, an unknown code, an empty value and a wrong-case value', async () => {
    const base = await get('');
    for (const q of ['?locale=en', '?locale=xx', '?locale=', '?locale=JA', '?other=1']) {
      expect(await get(q), q).toBe(base);
    }
  });

  it('reads only the FIRST value of a repeated locale parameter', async () => {
    const first = await get('?locale=ja&locale=ko');
    expect(JSON.parse(first).locale).toBe('ja');
    expect(first).toBe(await get('?locale=ja'));
    expect(await get('?locale=xx&locale=ko')).toBe(await get(''));
  });
});

describe('summaries — per tool', () => {
  it("serves the translation when its source is today's English summary", () => {
    const translations = emptyTranslations();
    translations.ko[firstTool.name] = { summary: '번역된 요약', source: firstTool.summary };
    expect(localizedSummary(firstTool.name, firstTool.summary, 'ko', translations)).toEqual({
      text: '번역된 요약',
      locale: 'ko',
    });
  });

  it('serves English when the English has been edited since (source differs)', () => {
    const translations = emptyTranslations();
    translations.ko[firstTool.name] = { summary: '번역된 요약', source: 'an older summary' };
    expect(localizedSummary(firstTool.name, firstTool.summary, 'ko', translations)).toEqual({
      text: firstTool.summary,
      locale: 'en',
    });
  });

  it("serves a tool a file does not name in its OWN English, and ignores other locales' files", () => {
    const translations = emptyTranslations();
    translations.de[firstTool.name] = { summary: 'Zusammenfassung', source: firstTool.summary };
    expect(localizedSummary(firstTool.name, firstTool.summary, 'ko', translations).locale).toBe(
      'en',
    );
  });

  it('serves English for an empty translated summary', () => {
    const translations = emptyTranslations();
    translations.ko[firstTool.name] = { summary: '', source: firstTool.summary };
    expect(localizedSummary(firstTool.name, firstTool.summary, 'ko', translations).locale).toBe(
      'en',
    );
  });
});

describe('group text — per group, both texts or neither', () => {
  const en = { label: firstGroup.label, gates: firstGroup.gates };
  const copy = { [slug]: { label: '레이블', description: '설명' } };
  const sources = {
    [`permissions.${slug}.label`]: en.label,
    [`permissions.${slug}.description`]: en.gates,
  };

  it('serves both translated when both keys exist and both sources match', () => {
    expect(localizedGroupText(slug, en, 'ko', groupDeps(copy, sources))).toEqual({
      text: { label: '레이블', gates: '설명' },
      locale: 'ko',
    });
  });

  it.each([
    ['label source differs', { ...sources, [`permissions.${slug}.label`]: 'old' }, copy],
    [
      'description source differs',
      { ...sources, [`permissions.${slug}.description`]: 'old' },
      copy,
    ],
    ['label source missing', { [`permissions.${slug}.description`]: en.gates }, copy],
    ['description key missing', sources, { [slug]: { label: '레이블' } }],
    ['label key missing', sources, { [slug]: { description: '설명' } }],
    ['group missing', sources, {}],
  ])('serves BOTH in English when %s', (_name, src, cp) => {
    expect(localizedGroupText(slug, en, 'ko', groupDeps(cp, src))).toEqual({
      text: en,
      locale: 'en',
    });
  });
});

describe('the localized document', () => {
  it('leaves everything but the human text deep-equal to the English document, for every locale', () => {
    for (const l of NON_EN) {
      const doc = mcpToolCatalogueDocument(l) as McpLocalizedToolCatalogueDocument;
      expect(doc.locale).toBe(l);
      expect(doc.toolCount).toBe(english.toolCount);
      expect(doc.endpoint).toBe(english.endpoint);
      expect(doc.groups.map((g) => [g.permission, g.grantedByDefault])).toEqual(
        english.groups.map((g) => [g.permission, g.grantedByDefault]),
      );
      for (const [i, group] of doc.groups.entries()) {
        expect(
          group.tools.map((t) => [t.name, t.permission, t.inputSchema, t.title, t.annotations]),
        ).toEqual(
          english.groups[i]!.tools.map((t) => [
            t.name,
            t.permission,
            t.inputSchema,
            t.title,
            t.annotations,
          ]),
        );
      }
    }
  });

  it('marks every row with the language its text is in', () => {
    const doc = mcpToolCatalogueDocument('ko') as McpLocalizedToolCatalogueDocument;
    for (const group of doc.groups) {
      expect(['ko', 'en']).toContain(group.textLocale);
      for (const tool of group.tools) expect(['ko', 'en']).toContain(tool.summaryLocale);
    }
  });

  it('serves a group translated from the app catalogue where its record is current', () => {
    const doc = mcpToolCatalogueDocument('ko') as McpLocalizedToolCatalogueDocument;
    const translated = doc.groups.filter((g) => g.textLocale === 'ko');
    expect(translated.length).toBeGreaterThan(0);
    const same = mcpCatalogue();
    for (const g of translated) {
      const base = same.find((e) => e.permission === g.permission)!;
      expect(g.label).not.toBe('');
      expect(g.gates).not.toBe('');
      expect(g.label === base.label && g.gates === base.gates).toBe(false);
    }
  });

  it('is memoized per locale', () => {
    expect(mcpToolCatalogueDocument('ko')).toBe(mcpToolCatalogueDocument('ko'));
    expect(mcpToolCatalogueDocument('ko')).not.toBe(mcpToolCatalogueDocument('ja'));
  });

  it('has a translations entry for every non-English locale', () => {
    expect(Object.keys(MCP_SUMMARY_TRANSLATIONS).sort()).toEqual([...NON_EN].sort());
  });
});

describe('the leaf keeps the route anonymous', () => {
  const FORBIDDEN = [
    /lib\/db/,
    /@prisma\/client/,
    /node:crypto/,
    /next-intl/,
    /from '@\/lib\/mcp\/(?!toolPermissions)/,
  ];

  function sources(): string[] {
    const dir = join(process.cwd(), 'lib', 'apiDocs', 'mcpSummaryTranslations');
    return [
      join(process.cwd(), 'lib', 'apiDocs', 'mcpCatalogueLocale.ts'),
      ...readdirSync(dir).map((f) => join(dir, f)),
    ];
  }

  it('imports nothing from lib/mcp except types, and no db, prisma, crypto or next-intl', () => {
    for (const file of sources()) {
      const text = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');
      for (const pattern of FORBIDDEN) expect(text, `${file} ${pattern}`).not.toMatch(pattern);
      for (const m of text.matchAll(/^import (?!type)[^;]*from '(@\/lib\/mcp\/[^']*)'/gm)) {
        throw new Error(`${file} has a value import from ${m[1]}`);
      }
    }
  });
});

afterEach(() => vi.restoreAllMocks());
