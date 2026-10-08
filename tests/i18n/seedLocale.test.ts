import { describe, expect, it } from 'vitest';
import { localeFromRequestHeaders } from '@/lib/i18n/seedLocale';

// Story MOTIR-7730 · MOTIR-7747 — the language a signing-up request resolves to.

const h = (init: Record<string, string>) => new Headers(init);

describe('localeFromRequestHeaders', () => {
  it('returns null with no headers — no request, no guess', () => {
    expect(localeFromRequestHeaders(null)).toBeNull();
    expect(localeFromRequestHeaders(undefined)).toBeNull();
  });

  it('prefers a valid NEXT_LOCALE choice over the browser', () => {
    expect(
      localeFromRequestHeaders(h({ cookie: 'a=1; NEXT_LOCALE=zh', 'accept-language': 'en-US' })),
    ).toBe('zh');
  });

  it('skips an invalid choice and falls to the browser', () => {
    expect(localeFromRequestHeaders(h({ cookie: 'NEXT_LOCALE=xx', 'accept-language': 'zh' }))).toBe(
      'zh',
    );
  });

  it('treats a malformed cookie value as no choice', () => {
    expect(
      localeFromRequestHeaders(h({ cookie: 'NEXT_LOCALE=%E0%A4%A', 'accept-language': 'zh-CN' })),
    ).toBe('zh');
  });

  it('matches the browser, then falls to English', () => {
    expect(localeFromRequestHeaders(h({ 'accept-language': 'zh-CN,zh;q=0.9' }))).toBe('zh');
    expect(localeFromRequestHeaders(h({ 'accept-language': 'sv-SE' }))).toBe('en');
    expect(localeFromRequestHeaders(h({}))).toBe('en');
  });
});
