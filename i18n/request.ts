import { getRequestConfig } from 'next-intl/server';
import { cookies, headers } from 'next/headers';
import { getSession } from '@/lib/auth';
import { resolveLocale } from '@/lib/i18n/resolveLocale';

// next-intl's per-request configuration (the "without i18n routing" setup).
// There is no `[locale]` route segment: the active locale is RESOLVED here, so
// server components, server actions, route handlers and generateMetadata all
// agree on it for the request. createNextIntlPlugin() in next.config.ts points
// at this file by default (./i18n/request.ts).
//
// The order (Story MOTIR-7730 · MOTIR-7743, `lib/i18n/resolveLocale.ts`): the
// signed-in person's saved account language, then the browser's `NEXT_LOCALE`
// choice, then the best `Accept-Language` match, then English. The saved
// language rides on the session (a Better-Auth additional field), and
// `getSession()` is memoised per render, so a signed-in page pays no extra
// query for it.
//
// Reading cookies / headers here opts request rendering into the dynamic path;
// every (authed) route is already dynamic (session), so this adds no cost there.
async function savedAccountLocale(): Promise<string | null> {
  // ⚠️ A FAILING SESSION READ MUST NOT FAIL THE PAGE. `getSession()` THROWS
  // `SessionUnavailableError` when the database does not answer (and a staff
  // session can throw its own gate errors). The language is not worth a 500:
  // the request resolves by steps 2–4 instead, and whatever owns the session on
  // this request meets the same failure and answers it in its own way.
  try {
    const session = await getSession();
    const saved: unknown = session?.user.locale;
    return typeof saved === 'string' ? saved : null;
  } catch {
    return null;
  }
}

export default getRequestConfig(async () => {
  const [cookieStore, requestHeaders, saved] = await Promise.all([
    cookies(),
    headers(),
    savedAccountLocale(),
  ]);
  const locale = resolveLocale({
    saved,
    cookie: cookieStore.get('NEXT_LOCALE')?.value,
    acceptLanguage: requestHeaders.get('accept-language'),
  });

  return {
    locale,
    // Relative path (not the @/ alias) so the bundler can statically glob the
    // messages/ directory and code-split each catalog.
    messages: (await import(`../messages/${locale}.json`)).default,
    // A single `now` per request, shared by SSR and the client. Without it,
    // next-intl's `format.relativeTime(...)` falls back to calling `new Date()`
    // independently on the server and again on the client (the
    // `ENVIRONMENT_FALLBACK: the \`now\` parameter wasn't provided to
    // \`relativeTime\`` warning) — the two instants differ, the rendered string
    // mismatches, React's hydration fails and regenerates the tree, and that
    // delays first paint and swallows early interactions (finding #89). Pinning
    // one `now` here serialises the same instant to the client provider
    // (NextIntlClientProvider inherits it via getConfigNow()), so SSR and the
    // client agree and the warning + hydration churn stop across EVERY page —
    // a root-cause, whole-class fix, not a per-spec re-time. This request is
    // already dynamic (it reads the cookies and headers above), so evaluating
    // `new Date()` here adds no rendering cost.
    now: new Date(),
    // The app pins UTC for absolute date/time formatting (lib/utils/datetime.ts;
    // dashboard / reports / filters already pass `timeZone: 'UTC'` explicitly).
    // Setting it as the global default makes `format.dateTime(...)` deterministic
    // between SSR and client too, killing the parallel `ENVIRONMENT_FALLBACK` for
    // `timeZone`. Explicit per-call `timeZone` options still override this.
    timeZone: 'UTC',
  };
});
