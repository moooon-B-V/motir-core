'use server';

import { cookies } from 'next/headers';
import { getSession, SessionUnavailableError } from '@/lib/auth';
import { usersService } from '@/lib/services/usersService';
import { isLocale, type Locale } from '@/lib/i18n/locales';
import { LOCALE_COOKIE, LOCALE_COOKIE_OPTIONS } from '@/lib/i18n/localeCookie';

// Persists the person's language choice. The client calls this from a
// transition and then router.refresh() so server components re-render in the
// new language — the same UX as the theme toggle, but server-readable.
//
// Signed in, the choice is saved ON THE ACCOUNT FIRST, then on this browser
// (Story MOTIR-7730 · MOTIR-7747). The order is load-bearing: `i18n/request.ts`
// ranks the saved account language above the cookie, so a cookie-only write
// would have the refresh render the OLD saved language. An account write that
// throws is rethrown and the cookie is not written, so the displayed language
// stays the saved one rather than half-changing.
//
// Signed out — or inside a staff "View as" session, which must not change the
// viewed person's account — the cookie is the whole choice, exactly as before.
export async function setLocale(locale: Locale): Promise<void> {
  if (!isLocale(locale)) return;
  let session: Awaited<ReturnType<typeof getSession>> = null;
  try {
    session = await getSession();
  } catch (err) {
    if (!(err instanceof SessionUnavailableError)) throw err;
  }
  if (session && !session.impersonation) {
    await usersService.setSavedLocale(session.user.id, locale);
  }
  (await cookies()).set(LOCALE_COOKIE, locale, LOCALE_COOKIE_OPTIONS);
}
