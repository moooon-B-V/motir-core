// Deterministic date/time formatters — pinned locale (`en-US`) + timezone
// (`UTC`) so a string is IDENTICAL when rendered on the server and re-rendered
// on the client. A runtime-default locale/timezone (`toLocaleString(undefined,
// …)`) differs between the two and triggers a React hydration mismatch; UTC is
// also the right default for an audit surface (issue timestamps, job runs), and
// the trailing "UTC" on the date-time form makes the zone explicit.
//
// Adopted as the single source of truth after the 1.6.5 jobs-dashboard
// hydration fix (PRODECT_FINDINGS — "reuse, don't re-derive"). The jobs
// dashboard and the issue detail page both render through these.

/** Date + time, e.g. "Jun 3, 02:45 PM UTC". Use for created/updated audit fields. */
export function formatDateTime(iso: string): string {
  return `${new Date(iso).toLocaleString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })} UTC`;
}

/** Calendar date only, e.g. "Jun 3, 2026". Use for due dates (no clock time). */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
