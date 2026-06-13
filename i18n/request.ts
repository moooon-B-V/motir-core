import { getRequestConfig } from 'next-intl/server';
import { cookies } from 'next/headers';
import { defaultLocale, isLocale } from '@/lib/i18n/locales';

// next-intl's per-request configuration (the "without i18n routing" setup). The
// active locale is read from the NEXT_LOCALE cookie — there is no `[locale]`
// route segment — so server components, server actions, and generateMetadata all
// resolve the same locale for the request. createNextIntlPlugin() in
// next.config.ts points at this file by default (./i18n/request.ts).
//
// Reading the cookie here opts request rendering into the dynamic path; every
// (authed) route is already dynamic (session), so this adds no cost there.
export default getRequestConfig(async () => {
  const cookieLocale = (await cookies()).get('NEXT_LOCALE')?.value;
  const locale = isLocale(cookieLocale) ? cookieLocale : defaultLocale;

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
    // already dynamic (it reads the NEXT_LOCALE cookie above), so evaluating
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
