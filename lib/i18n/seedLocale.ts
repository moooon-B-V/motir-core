import { LOCALE_COOKIE } from './localeCookie';
import type { Locale } from './locales';
import { resolveSignedOutLocale } from './resolveLocale';

// The language a SIGNING-UP request resolves to (Story MOTIR-7730 ·
// MOTIR-7747) — steps 2–4 of the order: the browser's `NEXT_LOCALE` choice,
// else the best `Accept-Language` match, else English. Written onto the new
// account in the user insert itself (`databaseHooks.user.create.before`).
//
// No headers means no request — a server-side create such as a seed script —
// and that saves NOTHING rather than guessing English: an account with no saved
// language falls through to its browser on every request, which is right.

function cookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return null; // a malformed value is no choice
    }
  }
  return null;
}

export function localeFromRequestHeaders(headers: Headers | null | undefined): Locale | null {
  if (!headers) return null;
  return resolveSignedOutLocale({
    cookie: cookieValue(headers.get('cookie'), LOCALE_COOKIE),
    acceptLanguage: headers.get('accept-language'),
  });
}
