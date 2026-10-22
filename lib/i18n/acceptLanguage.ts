import { locales, type Locale } from './locales';

// The best `Accept-Language` match among the app's locales (Story MOTIR-7730 ·
// MOTIR-7743) — step 3 of the request's locale resolution (`resolveLocale.ts`).
// Pure and Next-free, so it is unit-testable and importable anywhere.
//
// Ranges are taken in q order (header order on ties); `q=0` means "not this one"
// and is excluded; `*` says nothing about WHICH language and is ignored. For each
// range in turn an exact match wins; then the Traditional-Chinese rule; then a
// BASE-language match: `pt-BR` / `pt-PT` read as `pt`, `de-AT` as `de`.
//
// The Traditional-Chinese rule (MOTIR-8937 · MOTIR-9240): `zh-TW`, `zh-HK`,
// `zh-MO`, `zh-Hant` and any `zh-Hant-*` read as `zh-tw` WHEN the locale set
// holds it, and otherwise fall through to the base match and read as `zh`, the
// one Chinese catalogue. Simplified ranges (`zh`, `zh-CN`, `zh-SG`, `zh-Hans`,
// `zh-Hans-*`) always read as `zh`: the base match prefers the locale that IS
// the base over one that merely starts with it, so a set holding both `zh` and
// `zh-tw` never answers by list order. Candidates are read from `locales`, never
// a list of its own, so growing the locale set needs no change here.

interface WeightedRange {
  tag: string;
  q: number;
  order: number;
}

function parse(header: string): WeightedRange[] {
  const ranges: WeightedRange[] = [];
  header.split(',').forEach((part, order) => {
    const [rawTag, ...params] = part.trim().split(';');
    const tag = rawTag?.trim().toLowerCase() ?? '';
    if (!tag || tag === '*' || !/^[a-z]{1,8}(-[a-z0-9]{1,8})*$/.test(tag)) return;
    let q = 1;
    for (const param of params) {
      const [name, value] = param.trim().split('=');
      if (name?.trim().toLowerCase() !== 'q') continue;
      const parsed = Number(value?.trim());
      q = Number.isFinite(parsed) ? parsed : 0;
    }
    if (q <= 0) return;
    ranges.push({ tag, q, order });
  });
  return ranges.sort((a, b) => b.q - a.q || a.order - b.order);
}

/** Ranges a Traditional-Chinese reader sends: Taiwan, Hong Kong, Macau, or the Hant script. */
function isTraditionalChinese(tag: string): boolean {
  return (
    tag === 'zh-tw' ||
    tag === 'zh-hk' ||
    tag === 'zh-mo' ||
    tag === 'zh-hant' ||
    tag.startsWith('zh-hant-')
  );
}

/**
 * {@link matchAcceptLanguage} over an explicit candidate set — the same rule,
 * exported so it can be held against a set that does and does not hold `zh-tw`.
 */
export function matchAcceptLanguageAmong<L extends string>(
  header: string | null | undefined,
  candidates: readonly L[],
): L | null {
  if (!header) return null;
  const byCode = (code: string) => candidates.find((locale) => locale.toLowerCase() === code);
  for (const { tag } of parse(header)) {
    const exact = byCode(tag);
    if (exact) return exact;
    const traditional = isTraditionalChinese(tag) ? byCode('zh-tw') : undefined;
    if (traditional) return traditional;
    const base = tag.split('-')[0] ?? '';
    const byBase =
      byCode(base) ?? candidates.find((locale) => locale.toLowerCase().split('-')[0] === base);
    if (byBase) return byBase;
  }
  return null;
}

export function matchAcceptLanguage(header: string | null | undefined): Locale | null {
  return matchAcceptLanguageAmong(header, locales as readonly Locale[]);
}

/**
 * The browser's FIRST-ranked language range — after the same q-ordering
 * {@link matchAcceptLanguage} uses (`q=0` and `*` dropped) — lowercased, or
 * `null` for an empty or missing header (Story MOTIR-7731 · MOTIR-8093).
 *
 * Deliberately NOT a best match: it does not skip a range Motir has no locale
 * for. `sv, zh;q=0.9` answers `sv` here where {@link matchAcceptLanguage}
 * answers `zh`, because the organisation content-language rule reads the top
 * entry alone (`lib/i18n/contentLanguage.ts`).
 */
export function topAcceptLanguageTag(header: string | null | undefined): string | null {
  if (!header) return null;
  return parse(header)[0]?.tag ?? null;
}
