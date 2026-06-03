// Human-readable duration formatting for estimate fields (stored as a count of
// minutes on `work_item.estimateMinutes`). Hours + minutes is the right grain
// for issue estimates: "45m", "1h 30m", "10h". No locale/timezone concerns, so
// this is pure-arithmetic and SSR-safe by construction.

/**
 * Format a minute count as a compact "Xh Ym" duration.
 * - `< 60` → "45m"
 * - exact hours → "10h" (the "0m" tail is dropped)
 * - otherwise → "1h 30m"
 *
 * `0` renders "0m"; callers decide whether an absent estimate shows this or a
 * dedicated empty state (the detail panel shows "No estimate" for `null`).
 */
export function formatDurationMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins === 0 ? `${hours}h` : `${hours}h ${mins}m`;
}
