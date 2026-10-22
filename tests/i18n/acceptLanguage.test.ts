import { describe, expect, it } from 'vitest';
import { matchAcceptLanguage, matchAcceptLanguageAmong } from '@/lib/i18n/acceptLanguage';
import { locales } from '@/lib/i18n/locales';

// Story MOTIR-7730 · MOTIR-7743 — step 3 of the request's locale resolution.
describe('matchAcceptLanguage', () => {
  it('maps a regional Chinese variant to the one Chinese catalogue while the app has no zh-tw', () => {
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

// MOTIR-8937 · MOTIR-9240 — the Traditional-Chinese rule, held against both
// shapes of the locale set: without `zh-tw` (app.motir.co today) and with it
// (motir.co's set, listed after `zh` as it will be).
describe('matchAcceptLanguageAmong — Traditional Chinese', () => {
  const WITHOUT = ['en', 'zh', 'ja', 'pt', 'de'] as const;
  const WITH = ['en', 'zh', 'zh-tw', 'ja', 'pt', 'de'] as const;
  const TRADITIONAL = ['zh-TW', 'zh-Hant', 'zh-HK', 'zh-MO', 'zh-Hant-TW', 'zh-Hant-HK'];
  const SIMPLIFIED = ['zh', 'zh-CN', 'zh-SG', 'zh-Hans', 'zh-Hans-CN'];

  it.each(TRADITIONAL)('%s reads as zh-tw when the set holds it', (header) => {
    expect(matchAcceptLanguageAmong(header, WITH)).toBe('zh-tw');
    expect(matchAcceptLanguageAmong(header.toUpperCase(), WITH)).toBe('zh-tw');
    expect(matchAcceptLanguageAmong(header.toLowerCase(), WITH)).toBe('zh-tw');
  });

  it.each(TRADITIONAL)('%s falls back to zh when the set has no zh-tw', (header) => {
    expect(matchAcceptLanguageAmong(header, WITHOUT)).toBe('zh');
  });

  it.each(SIMPLIFIED)('%s reads as zh whether or not the set holds zh-tw', (header) => {
    expect(matchAcceptLanguageAmong(header, WITH)).toBe('zh');
    expect(matchAcceptLanguageAmong(header, WITHOUT)).toBe('zh');
  });

  it('answers zh for a bare zh even when zh-tw is listed first', () => {
    expect(matchAcceptLanguageAmong('zh', ['zh-tw', 'zh', 'en'])).toBe('zh');
    expect(matchAcceptLanguageAmong('zh-CN', ['zh-tw', 'zh', 'en'])).toBe('zh');
  });

  it('keeps q-ordering across ranges', () => {
    expect(matchAcceptLanguageAmong('en, zh-TW;q=0.5', WITH)).toBe('en');
    expect(matchAcceptLanguageAmong('zh-TW, en;q=0.5', WITH)).toBe('zh-tw');
    expect(matchAcceptLanguageAmong('zh-TW;q=0, en', WITH)).toBe('en');
    expect(matchAcceptLanguageAmong('zh-CN;q=0.4, zh-TW;q=0.6', WITH)).toBe('zh-tw');
    expect(matchAcceptLanguageAmong('zh-TW;q=0.4, zh-CN;q=0.6', WITH)).toBe('zh');
  });

  it('leaves other languages, the wildcard and an empty header as they were', () => {
    for (const set of [WITH, WITHOUT]) {
      expect(matchAcceptLanguageAmong('pt-BR', set)).toBe('pt');
      expect(matchAcceptLanguageAmong('de-AT', set)).toBe('de');
      expect(matchAcceptLanguageAmong('*', set)).toBeNull();
      expect(matchAcceptLanguageAmong('', set)).toBeNull();
      expect(matchAcceptLanguageAmong('sv', set)).toBeNull();
    }
  });

  it('is what matchAcceptLanguage runs over the app’s own locales', () => {
    for (const header of [...TRADITIONAL, ...SIMPLIFIED, 'pt-BR', 'en, zh-TW;q=0.5']) {
      expect(matchAcceptLanguage(header)).toBe(matchAcceptLanguageAmong(header, locales));
    }
  });
});
