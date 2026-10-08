import { matchAcceptLanguage } from './acceptLanguage';
import { defaultLocale, isLocale, type Locale } from './locales';

// The ONE order every app.motir.co request resolves its language in (Story
// MOTIR-7730 · MOTIR-7743):
//
//   1. the signed-in person's SAVED account language (`user.locale`);
//   2. the browser's `NEXT_LOCALE` choice;
//   3. the best `Accept-Language` match;
//   4. English.
//
// A value that fails `isLocale` — a stored value from a retired locale, a
// hand-edited cookie — is SKIPPED and resolution falls to the next step. It is
// never mapped to some default member, because that would let a bad value
// outrank a good one further down.

export interface LocaleSignals {
  saved?: string | null;
  cookie?: string | null;
  acceptLanguage?: string | null;
}

/** Steps 2–4 — the order a request with no account resolves by, and the one the
 *  sign-up seed writes onto a new account. */
export function resolveSignedOutLocale({
  cookie,
  acceptLanguage,
}: Omit<LocaleSignals, 'saved'>): Locale {
  if (isLocale(cookie)) return cookie;
  return matchAcceptLanguage(acceptLanguage) ?? defaultLocale;
}

/** All four steps. */
export function resolveLocale({ saved, cookie, acceptLanguage }: LocaleSignals): Locale {
  if (isLocale(saved)) return saved;
  return resolveSignedOutLocale({ cookie, acceptLanguage });
}
