// Locale-aware, hydration-safe date/time formatters. The formatting LOCALE is
// the user's active locale (passed in by the caller — `useLocale()` in a client
// component, `getLocale()` on the server), mapped to a BCP-47 tag below. Because
// that locale comes from the NEXT_LOCALE cookie it is IDENTICAL on the server
// and on the client, so passing it explicitly is hydration-safe — unlike a
// runtime default (`toLocaleString(undefined, …)`), which differs between the
// two and triggers a React mismatch.
//
// The TIMEZONE stays pinned to `UTC`: it's the right default for an audit
// surface (issue timestamps, job runs), the trailing "UTC" makes the zone
// explicit, and a per-user timezone isn't persisted (so the server couldn't
// render the viewer's zone deterministically — a future enhancement).
//
// `locale` defaults to the base locale so an un-threaded call (and the unit
// suite) keeps the original en-US output. Adopted as the single source of truth
// after the 1.6.5 jobs-dashboard hydration fix (PRODECT_FINDINGS — "reuse,
// don't re-derive").

import { defaultLocale, type Locale } from '@/lib/i18n/locales';

// App locale → BCP-47 tag for Intl. Add a row here when a locale ships.
const BCP47: Record<Locale, string> = {
  en: 'en-US',
  zh: 'zh-CN',
};

/** Date + time, e.g. "Jun 3, 02:45 PM UTC" (en) · "6月3日 下午02:45 UTC" (zh). */
export function formatDateTime(iso: string, locale: Locale = defaultLocale): string {
  return `${new Date(iso).toLocaleString(BCP47[locale], {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })} UTC`;
}

/** Calendar date only, e.g. "Jun 3, 2026" (en) · "2026年6月3日" (zh). */
export function formatDate(iso: string, locale: Locale = defaultLocale): string {
  return new Date(iso).toLocaleString(BCP47[locale], {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
