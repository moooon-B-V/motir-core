import { describe, expect, it } from 'vitest';
import { topAcceptLanguageTag } from '@/lib/i18n/acceptLanguage';
import { contentLanguageFromAcceptLanguage } from '@/lib/i18n/contentLanguage';

// Story MOTIR-7731 · MOTIR-8093 — a new organisation's content language comes
// from the creator's TOP Accept-Language tag: `zh` for a Chinese browser, `en`
// for every other one (and for no header at all).

describe('contentLanguageFromAcceptLanguage', () => {
  it.each([
    ['zh-CN,zh;q=0.9,en;q=0.8', 'zh'],
    ['zh', 'zh'],
    ['zh-TW', 'zh'],
    ['zh-Hant-HK;q=0.9, en;q=0.5', 'zh'],
    ['en-US,en;q=0.9', 'en'],
    ['sv-SE', 'en'],
    ['ja,zh;q=0.9', 'en'],
    ['en;q=0.5, zh;q=0.9', 'zh'],
    ['zh;q=0.5', 'zh'],
    ['de', 'en'],
    ['sv, zh;q=0.9', 'en'],
    ['zh;q=0, en', 'en'],
    ['*', 'en'],
  ])('%s → %s', (header, expected) => {
    expect(contentLanguageFromAcceptLanguage(header)).toBe(expected);
  });

  it('is en with no header', () => {
    expect(contentLanguageFromAcceptLanguage(null)).toBe('en');
    expect(contentLanguageFromAcceptLanguage(undefined)).toBe('en');
    expect(contentLanguageFromAcceptLanguage('')).toBe('en');
  });

  it('reads only the top tag — a lower-ranked Chinese does not count', () => {
    expect(topAcceptLanguageTag('ja,zh;q=0.9')?.toLowerCase()).toMatch(/^ja/);
    expect(contentLanguageFromAcceptLanguage('ja,zh;q=0.9')).toBe('en');
  });
});
