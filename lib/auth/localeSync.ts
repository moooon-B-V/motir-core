import { createAuthMiddleware } from 'better-auth/api';
import type { BetterAuthPlugin } from 'better-auth';
import { isLocale } from '@/lib/i18n/locales';
import { LOCALE_COOKIE, LOCALE_COOKIE_OPTIONS } from '@/lib/i18n/localeCookie';

// Sign-in brings this browser's language choice in line with the account
// (Story MOTIR-7730 · MOTIR-7747).
//
// While signed in, `i18n/request.ts` already ranks the saved account language
// first, so this changes nothing on an authed page. What it buys is the page
// AFTER sign-out: the browser's `NEXT_LOCALE` now says what the account says, so
// the sign-in page keeps the person's language.
//
// Keyed on `ctx.context.newSession`, not on a path list, so every way in —
// email and password, the Google callback, the two-factor verify step, and any
// path added later — is covered without an edit. A database `session.create`
// hook cannot set a response cookie; an endpoint `after` hook can, including on
// the Google callback's redirect (the cookie is `SameSite=Lax`, so it rides the
// top-level GET back from Google).
//
// It never WRITES the account, a null saved language leaves the cookie alone,
// and a cookie that already agrees is not re-sent.
//
// Annotated rather than inferred, for the TS2742 reason `mcpOAuthPolicy.ts`
// records.

function requestCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq >= 0 && part.slice(0, eq).trim() === LOCALE_COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

export function localeSync(): BetterAuthPlugin {
  return {
    id: 'locale-sync',
    hooks: {
      after: [
        {
          matcher: (ctx) => ctx.context.newSession != null,
          handler: createAuthMiddleware(async (ctx) => {
            const user = ctx.context.newSession?.user as { locale?: unknown } | undefined;
            const saved = typeof user?.locale === 'string' ? user.locale : null;
            if (!isLocale(saved)) return;
            if (requestCookie(ctx.headers?.get('cookie')) === saved) return;
            ctx.setCookie(LOCALE_COOKIE, saved, {
              path: LOCALE_COOKIE_OPTIONS.path,
              maxAge: LOCALE_COOKIE_OPTIONS.maxAge,
              sameSite: LOCALE_COOKIE_OPTIONS.sameSite,
            });
          }),
        },
      ],
    },
  };
}
