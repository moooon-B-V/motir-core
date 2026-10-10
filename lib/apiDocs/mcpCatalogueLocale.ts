import { isLocale, type Locale } from '@/lib/i18n/locales';
import type { McpCatalogueToolName } from '@/lib/apiDocs/mcp';
import { MCP_SUMMARY_TRANSLATIONS } from './mcpSummaryTranslations';
import type { McpSummaryTranslations } from './mcpSummaryTranslations/types';
import zhMessages from '@/messages/zh.json';
import jaMessages from '@/messages/ja.json';
import koMessages from '@/messages/ko.json';
import deMessages from '@/messages/de.json';
import frMessages from '@/messages/fr.json';
import esMessages from '@/messages/es.json';
import itMessages from '@/messages/it.json';
import nlMessages from '@/messages/nl.json';
import plMessages from '@/messages/pl.json';
import ptMessages from '@/messages/pt.json';
import zhSources from '@/messages/sources/zh.json';
import jaSources from '@/messages/sources/ja.json';
import koSources from '@/messages/sources/ko.json';
import deSources from '@/messages/sources/de.json';
import frSources from '@/messages/sources/fr.json';
import esSources from '@/messages/sources/es.json';
import itSources from '@/messages/sources/it.json';
import nlSources from '@/messages/sources/nl.json';
import plSources from '@/messages/sources/pl.json';
import ptSources from '@/messages/sources/pt.json';

// The locale layer of the published MCP tool catalogue (MOTIR-8031).
//
// A LEAF: it imports no registry, no Prisma, no `lib/db`, no `node:crypto` and
// no next-intl — the same dependency-graph rule `lib/apiDocs/mcp.ts` keeps — so
// the anonymous route that serves the catalogue stays free of all of them.
//
// What it decides is one thing: for a locale, is a piece of human text served
// translated or in English? The rule is per tool and per group, and a translation
// counts only while the English it was made from still equals today's English:
//   - a SUMMARY: `source` in `lib/apiDocs/mcpSummaryTranslations/<locale>.ts`;
//   - a GROUP's `label` + `gates`: the app catalogue's own `permissions.<slug>.*`
//     in `messages/<locale>.json`, checked against `messages/sources/<locale>.json`.
// The group texts are NOT a second copy — they are the strings the Roles &
// permissions screen already renders, translated and source-recorded by the app's
// catalogue tooling. A stale or missing one falls back to English, never fails.

export type CatalogueLocale = Exclude<Locale, 'en'>;

/** The served locale for a raw query value, or `null` for English / anything else. */
export function resolveCatalogueLocale(raw: string | null | undefined): CatalogueLocale | null {
  if (!isLocale(raw) || raw === 'en') return null;
  return raw;
}

interface PermissionCopy {
  label?: string;
  description?: string;
}

export interface GroupTextDeps {
  /** The `permissions` subtree of `messages/<locale>.json`. */
  copy: Record<CatalogueLocale, Record<string, unknown>>;
  /** `messages/sources/<locale>.json`: dotted key → the English it was made from. */
  sources: Record<CatalogueLocale, Record<string, string>>;
}

const PERMISSIONS = (m: { permissions: unknown }) => m.permissions as Record<string, unknown>;

export const SHIPPED_GROUP_TEXT: GroupTextDeps = {
  copy: {
    zh: PERMISSIONS(zhMessages),
    ja: PERMISSIONS(jaMessages),
    ko: PERMISSIONS(koMessages),
    de: PERMISSIONS(deMessages),
    fr: PERMISSIONS(frMessages),
    es: PERMISSIONS(esMessages),
    it: PERMISSIONS(itMessages),
    nl: PERMISSIONS(nlMessages),
    pl: PERMISSIONS(plMessages),
    pt: PERMISSIONS(ptMessages),
  },
  sources: {
    zh: zhSources,
    ja: jaSources,
    ko: koSources,
    de: deSources,
    fr: frSources,
    es: esSources,
    it: itSources,
    nl: nlSources,
    pl: plSources,
    pt: ptSources,
  },
};

export interface LocalizedText<T> {
  text: T;
  locale: Locale;
}

/**
 * One tool's summary in `locale`: the translation when its recorded `source` is
 * today's `englishSummary`, otherwise `englishSummary` itself. A tool a
 * translation file does not name resolves to its OWN English, never another's.
 */
export function localizedSummary(
  name: McpCatalogueToolName,
  englishSummary: string,
  locale: CatalogueLocale,
  translations: Record<CatalogueLocale, McpSummaryTranslations> = MCP_SUMMARY_TRANSLATIONS,
): LocalizedText<string> {
  const entry = translations[locale][name];
  if (entry && entry.source === englishSummary && entry.summary.length > 0) {
    return { text: entry.summary, locale };
  }
  return { text: englishSummary, locale: 'en' };
}

/**
 * One group's `label` + `gates` in `locale`. Both are served translated only when
 * BOTH keys exist and BOTH recorded sources equal today's English; otherwise both
 * are English, so a heading is never half one language.
 */
export function localizedGroupText(
  slug: string,
  english: { label: string; gates: string },
  locale: CatalogueLocale,
  deps: GroupTextDeps = SHIPPED_GROUP_TEXT,
): LocalizedText<{ label: string; gates: string }> {
  const fallback = { text: english, locale: 'en' as const };
  const copy = deps.copy[locale][slug] as PermissionCopy | undefined;
  const sources = deps.sources[locale];
  const label = copy?.label;
  const description = copy?.description;
  if (typeof label !== 'string' || label.length === 0) return fallback;
  if (typeof description !== 'string' || description.length === 0) return fallback;
  if (sources[`permissions.${slug}.label`] !== english.label) return fallback;
  if (sources[`permissions.${slug}.description`] !== english.gates) return fallback;
  return { text: { label, gates: description }, locale };
}
