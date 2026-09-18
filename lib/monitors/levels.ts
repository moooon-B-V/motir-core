// The monitor-issue LEVEL vocabulary (Story MOTIR-4929 · Subtask MOTIR-5576) —
// the ordered set a connection's minimum level is chosen from, and the one
// predicate that decides whether an issue qualifies.
//
// ⚠️ AN ISSUE WHOSE LEVEL IS NULL OR UNRECOGNISED QUALIFIES. The minimum level
// is a noise control, not a classifier: an issue the provider reported with no
// level, or with one this list has never heard of, is still an error somebody
// may need to act on. Dropping it would lose errors SILENTLY, which is the exact
// failure the monitoring epic exists to end (MOTIR-4918). So the filter only
// ever removes an issue it can positively place BELOW the minimum.

/** The provider levels, LOWEST first. The order is the whole contract. */
export const MONITOR_LEVELS = ['debug', 'info', 'warning', 'error', 'fatal'] as const;

export type MonitorLevel = (typeof MONITOR_LEVELS)[number];

/** Is `value` one of the five levels? The type guard the minimum-level write
 *  validates its input with. */
export function isMonitorLevel(value: unknown): value is MonitorLevel {
  return typeof value === 'string' && (MONITOR_LEVELS as readonly string[]).includes(value);
}

/** The rank of a level, or `-1` for `null` / an unrecognised string — so that
 *  "no level" sorts below every real one. */
function rank(level: string | null): number {
  return level === null ? -1 : (MONITOR_LEVELS as readonly string[]).indexOf(level);
}

/**
 * Does an issue at `level` qualify under a connection's `minimum`?
 *
 * - `minimum` null ⇒ every level qualifies (the shipped default).
 * - `level` null or not one of {@link MONITOR_LEVELS} ⇒ QUALIFIES at every
 *   minimum (see the header — a level we cannot place is never grounds to drop an
 *   error).
 * - otherwise ⇒ `level` is at or above `minimum`.
 *
 * A minimum that is itself unrecognised cannot be placed either, so it filters
 * nothing — the write refuses such a value, and this read does not second-guess
 * a row that somehow holds one.
 */
export function meetsMinimumLevel(level: string | null, minimum: string | null): boolean {
  if (minimum === null || !isMonitorLevel(minimum)) return true;
  if (level === null || !isMonitorLevel(level)) return true;
  return rank(level) >= rank(minimum);
}

/**
 * Is minimum `a` LOWER than minimum `b`, with `null` (every level) the lowest?
 *
 * The minimum-level write uses it to decide a REWIND: lowering the minimum
 * admits issues the poll already read past and skipped, so the watermark has to
 * go back for them to be read again. Raising it admits nothing new.
 */
export function isLowerThan(a: string | null, b: string | null): boolean {
  return rank(a) < rank(b);
}
