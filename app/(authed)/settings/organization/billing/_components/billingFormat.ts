// Formatting shared by the billing page and its dialogs. The figures are the
// server's; these only render them in the reader's locale.

export function fmt(n: number, locale: string): string {
  return n.toLocaleString(locale);
}

export function fmtDate(value: string | number | null, locale: string): string | null {
  if (value == null) return null;
  const d = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** Integer cents of `currency` (lower-case ISO 4217, as Stripe gives it) as money. */
export function fmtMoney(cents: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}
