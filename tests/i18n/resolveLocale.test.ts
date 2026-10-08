import { describe, expect, it } from 'vitest';
import { resolveLocale, resolveSignedOutLocale } from '@/lib/i18n/resolveLocale';

// Story MOTIR-7730 · MOTIR-7743 — the four-step order.
describe('resolveLocale', () => {
  it('signed out: follows the browser, and falls to English for an unspoken language', () => {
    expect(resolveLocale({ acceptLanguage: 'zh-TW,zh;q=0.9,en;q=0.5' })).toBe('zh');
    expect(resolveLocale({ acceptLanguage: 'sv-SE,sv;q=0.9' })).toBe('en');
    expect(resolveLocale({})).toBe('en');
  });

  it('signed out: the NEXT_LOCALE choice beats the browser', () => {
    expect(resolveLocale({ cookie: 'en', acceptLanguage: 'zh' })).toBe('en');
  });

  it('skips an invalid cookie rather than trusting it', () => {
    expect(resolveLocale({ cookie: 'xx', acceptLanguage: 'zh' })).toBe('zh');
  });

  it('signed in: the saved account language beats both the choice and the browser', () => {
    expect(resolveLocale({ saved: 'zh', cookie: 'en', acceptLanguage: 'en-US' })).toBe('zh');
  });

  it('signed in with nothing saved, or a value no locale matches, falls through in order', () => {
    expect(resolveLocale({ saved: null, cookie: 'zh', acceptLanguage: 'en' })).toBe('zh');
    expect(resolveLocale({ saved: 'xx', cookie: undefined, acceptLanguage: 'zh' })).toBe('zh');
    expect(resolveLocale({ saved: 'xx', cookie: 'yy', acceptLanguage: 'sv' })).toBe('en');
  });
});

describe('resolveSignedOutLocale', () => {
  it('is steps 2–4 only', () => {
    expect(resolveSignedOutLocale({ cookie: 'zh', acceptLanguage: 'en' })).toBe('zh');
    expect(resolveSignedOutLocale({ cookie: null, acceptLanguage: 'zh-CN' })).toBe('zh');
    expect(resolveSignedOutLocale({ cookie: 'xx', acceptLanguage: null })).toBe('en');
  });
});
