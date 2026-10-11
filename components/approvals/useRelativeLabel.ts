'use client';

import { useLocale } from 'next-intl';

/** Relative time — "4 days", in the active locale; the absolute date goes on hover. */
export function useRelativeLabel(): (iso: string) => string {
  const locale = useLocale();
  return (iso: string) => {
    const ms = Date.now() - new Date(iso).getTime();
    const hours = Math.round(ms / 3_600_000);
    const fmt = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' });
    // Clamped at 0 in both units: a clock skew must not render "in 2 hours" on a
    // list of things that have already happened.
    return hours < 48
      ? fmt.format(-Math.max(hours, 0), 'hour')
      : fmt.format(-Math.max(Math.round(hours / 24), 0), 'day');
  };
}
