import { describe, expect, it } from 'vitest';
import { matchAcceptLanguage } from '@/lib/i18n/acceptLanguage';
import { locales } from '@/lib/i18n/locales';

// Story MOTIR-7730 · MOTIR-7743 — step 3 of the request's locale resolution.
describe('matchAcceptLanguage', () => {
  it('maps a regional Chinese variant to the one Chinese catalogue', () => {
    expect(matchAcceptLanguage('zh-TW,zh;q=0.9,en;q=0.5')).toBe('zh');
    expect(matchAcceptLanguage('zh-Hant')).toBe('zh');
  });

  it('answers null for a browser asking only for a language the app does not speak', () => {
    expect(matchAcceptLanguage('sv-SE,sv;q=0.9')).toBeNull();
  });

  it('orders ranges by q, not by header position', () => {
    expect(matchAcceptLanguage('en;q=0.2, zh;q=0.8')).toBe('zh');
  });

  it('keeps header order between equal q values', () => {
    expect(matchAcceptLanguage('zh, en')).toBe('zh');
    expect(matchAcceptLanguage('en, zh')).toBe('en');
  });

  it('excludes a q=0 range', () => {
    expect(matchAcceptLanguage('zh;q=0, en')).toBe('en');
  });

  it('ignores the * wildcard', () => {
    expect(matchAcceptLanguage('*')).toBeNull();
    expect(matchAcceptLanguage('*, zh;q=0.5')).toBe('zh');
  });

  it('matches case-insensitively', () => {
    expect(matchAcceptLanguage('ZH-cn')).toBe('zh');
  });

  it('answers null for empty, null, undefined and garbage headers', () => {
    expect(matchAcceptLanguage('')).toBeNull();
    expect(matchAcceptLanguage(null)).toBeNull();
    expect(matchAcceptLanguage(undefined)).toBeNull();
    expect(matchAcceptLanguage(';;;,,,q=1')).toBeNull();
    expect(matchAcceptLanguage('12345, @@')).toBeNull();
  });

  it('treats an unparseable q as zero', () => {
    expect(matchAcceptLanguage('zh;q=abc, en;q=0.1')).toBe('en');
  });

  it('reads its candidates from `locales` — every member matches its own code', () => {
    for (const locale of locales) {
      expect(matchAcceptLanguage(locale)).toBe(locale);
      expect(matchAcceptLanguage(`${locale}-XX`)).toBe(locale);
    }
  });
});
