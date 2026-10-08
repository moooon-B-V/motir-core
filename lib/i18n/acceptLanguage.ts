import { locales, type Locale } from './locales';

// The best `Accept-Language` match among the app's locales (Story MOTIR-7730 ·
// MOTIR-7743) — step 3 of the request's locale resolution (`resolveLocale.ts`).
// Pure and Next-free, so it is unit-testable and importable anywhere.
//
// Ranges are taken in q order (header order on ties); `q=0` means "not this one"
// and is excluded; `*` says nothing about WHICH language and is ignored. For each
// range in turn an exact match wins, else a BASE-language match: `zh-TW` and
// `zh-Hant` read as `zh` (the one Chinese catalogue), `pt-BR` / `pt-PT` as `pt`,
// `de-AT` as `de`. Candidates are read from `locales`, never a list of its own,
// so growing the locale set needs no change here.

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

export function matchAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;
  const candidates = locales as readonly Locale[];
  for (const { tag } of parse(header)) {
    const exact = candidates.find((locale) => locale.toLowerCase() === tag);
    if (exact) return exact;
    const base = tag.split('-')[0];
    const byBase = candidates.find((locale) => locale.toLowerCase().split('-')[0] === base);
    if (byBase) return byBase;
  }
  return null;
}
