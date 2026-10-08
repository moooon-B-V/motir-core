// The single source of truth for the locale set. UI-free so it can be imported
// from anywhere — server components, client components, the `proxy`, and the
// `i18n/request.ts` request config — without dragging in React or next-intl.
//
// Adding a locale is a catalogue (`messages/<code>.json`, every key `en.json`
// holds — `tests/i18n-catalog.test.ts` holds it to parity), a row in each map
// typed `Record<Locale, …>` (`localeDir` / `localeLabel` here, `BCP47` in
// `lib/utils/datetime.ts`, the catalogue import in `lib/i18n/messages.ts`) and a
// server-error copy entry (`GLOBAL_ERROR_COPY` in
// `components/errors/serverErrorCopy.ts`). The type checker names each one.
// The order below is the order the language controls list them.

export const locales = ['en', 'zh', 'ja', 'ko', 'de', 'fr', 'es', 'it', 'nl', 'pl', 'pt'] as const;

export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = 'en';

// Writing direction per locale. Every shipped locale is LTR today; this map is
// kept so a future RTL locale (e.g. 'fa', 'ar') only needs an entry here and the
// `<html dir>` in the root layout flips automatically — no structural change.
export const localeDir: Record<Locale, 'ltr' | 'rtl'> = {
  en: 'ltr',
  zh: 'ltr',
  ja: 'ltr',
  ko: 'ltr',
  de: 'ltr',
  fr: 'ltr',
  es: 'ltr',
  it: 'ltr',
  nl: 'ltr',
  pl: 'ltr',
  pt: 'ltr',
};

// Endonyms (each language's name in its own script) for the locale switcher.
export const localeLabel: Record<Locale, string> = {
  en: 'English',
  zh: '中文',
  ja: '日本語',
  ko: '한국어',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  it: 'Italiano',
  nl: 'Nederlands',
  pl: 'Polski',
  pt: 'Português',
};

export function isLocale(value: string | undefined | null): value is Locale {
  return value != null && (locales as readonly string[]).includes(value);
}
