import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import en from '@/messages/en.json';
import ja from '@/messages/ja.json';
import { locales, type Locale } from '@/lib/i18n/locales';
import { getMessagesFor, withEnglishFallback } from '@/lib/i18n/messages';
import { formatDate, formatDateTime } from '@/lib/utils/datetime';

// Story MOTIR-7730 · MOTIR-7757 — a message a catalogue lacks renders its
// ENGLISH text, never its raw key path, and the eleven locales each format a
// date the way their language writes one.

describe('withEnglishFallback', () => {
  const base = { a: { x: 'X', y: 'Y' }, b: { z: 'Z' }, c: 'C' };

  it('fills a missing leaf and a missing namespace, and keeps a present translation', () => {
    const merged = withEnglishFallback({ a: { x: 'エックス' }, c: 'シー' }, base);
    expect(merged).toEqual({ a: { x: 'エックス', y: 'Y' }, b: { z: 'Z' }, c: 'シー' });
  });

  it('mutates neither input', () => {
    const messages = { a: { x: 'エックス' } };
    const before = JSON.stringify([messages, base]);
    withEnglishFallback(messages, base);
    expect(JSON.stringify([messages, base])).toBe(before);
  });

  it('renders a key deleted from ja in English, with no MISSING_MESSAGE', () => {
    const partial = structuredClone(ja) as typeof ja;
    delete (partial.errors.serverError as Partial<typeof ja.errors.serverError>).appTitle;

    const errors: string[] = [];
    const t = createTranslator({
      locale: 'ja',
      messages: withEnglishFallback(partial, en) as typeof en,
      namespace: 'errors.serverError',
      onError: (error) => errors.push(error.code),
    });

    expect(t('appTitle')).toBe(en.errors.serverError.appTitle);
    expect(t('retrying')).toBe(ja.errors.serverError.retrying);
    expect(errors).toEqual([]);
  });
});

describe('getMessagesFor', () => {
  it.each(locales)('returns a full catalogue for %s', (locale) => {
    const messages = getMessagesFor(locale) as typeof en;
    expect(messages.common.retry).toEqual(expect.any(String));
    expect(Object.keys(messages).sort()).toEqual(Object.keys(en).sort());
  });
});

describe('dates in the reader’s language', () => {
  it('writes October 7 the Japanese and the German way', () => {
    expect(formatDate('2026-10-07T00:00:00Z', 'ja')).toContain('10月7日');
    expect(formatDate('2026-10-07T00:00:00Z', 'de')).toContain('7. Okt.');
  });
});

// Story gate MOTIR-7760 — the remaining arms of the loader and the formatter.
describe('the loader and the formatter at their edges (MOTIR-7760)', () => {
  it('keeps a key the locale holds that English does not', () => {
    expect(withEnglishFallback({ extra: 'E', c: 'シー' }, { c: 'C' })).toEqual({
      c: 'シー',
      extra: 'E',
    });
  });

  it('answers English for a locale it does not know, rather than throwing', () => {
    expect(getMessagesFor('xx' as Locale)).toBe(getMessagesFor('en'));
  });

  it('formats a date and time in the reader’s language, US English by default', () => {
    const iso = '2026-10-07T14:05:00Z';
    expect(formatDateTime(iso)).toBe('Oct 7, 02:05 PM UTC');
    expect(formatDateTime(iso, 'de')).toBe('7. Okt., 14:05 UTC');
    expect(formatDate(iso)).toBe('Oct 7, 2026');
  });
});
