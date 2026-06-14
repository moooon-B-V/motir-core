import { generateKeyBetween } from 'fractional-indexing';

// Fractional-indexing helpers for work-item ordering (Story 1.4).
//
// `position` orders siblings within a parent. Fractional indexing (the
// Linear/Notion shape) lets a reorder be a single-row write: to move an item
// between two neighbours you only mint a new key that sorts between their two
// keys — no cascade of re-numbering. Keys are opaque, lexicographically
// sortable strings (base-62 by default, e.g. "a0", "a0V", "Zz").
//
// These three helpers are thin, total wrappers over `generateKeyBetween`
// (which takes nullable bounds, where null means "open end"):
//   - keyForAppend(last)        → after the current last item (or first item)
//   - keyForPrepend(first)      → before the current first item (or first item)
//   - keyBetween(prev, next)    → between two existing neighbours
//
// The single source of truth for ordering correctness is `generateKeyBetween`
// itself; these wrappers only name the three call sites the service uses so
// the intent reads clearly at the call site. They throw (via the library) if
// given out-of-order bounds (prev >= next) — that's a programming error the
// service must avoid, not a runtime condition to swallow.

/**
 * A key that sorts AFTER `last` (the current last sibling's position), or the
 * first key in an empty list when `last` is null.
 */
export function keyForAppend(last: string | null): string {
  return generateKeyBetween(last, null);
}

/**
 * A key that sorts BEFORE `first` (the current first sibling's position), or
 * the first key in an empty list when `first` is null.
 */
export function keyForPrepend(first: string | null): string {
  return generateKeyBetween(null, first);
}

/**
 * A key that sorts strictly between `prev` and `next`. Either bound may be
 * null to mean "open end" (equivalent to append when `next` is null, prepend
 * when `prev` is null). Throws if `prev >= next`.
 */
export function keyBetween(prev: string | null, next: string | null): string {
  return generateKeyBetween(prev, next);
}

/**
 * Whether `k` is a valid fractional-index key — one `generateKeyBetween` will
 * accept as a bound. A `null`/empty value, or a malformed key (e.g. a legacy
 * zero-padded number, head `'0'`), is invalid. Probes the library's own
 * validation by using `k` as a lower bound against an open upper end.
 */
export function isValidOrderKey(k: string | null | undefined): k is string {
  if (k === null || k === undefined || k === '') return false;
  try {
    generateKeyBetween(k, null);
    return true;
  } catch {
    return false;
  }
}

/**
 * Like {@link keyBetween}, but TOLERANT of bad bounds — it ALWAYS returns a
 * valid key instead of throwing. Two real-world inputs make the raw
 * `generateKeyBetween` throw, and neither should ever 500 a user's reorder:
 *
 *  1. A **malformed/legacy bound** — a stored `position` that isn't a valid
 *     fractional-index key (e.g. a zero-padded number from an old seed). Such a
 *     bound is treated as an open end (`null`).
 *  2. An **inverted pair** (`prev > next`) — the bounds arrive in display order,
 *     but a surface whose display order ≠ `position` order (a recency-ranked
 *     terminal board column) can hand them over position-inverted. The bounds
 *     are ordered by their actual key; an exact tie drops the upper bound so the
 *     new key appends after the lower one.
 *
 * The resulting key is always valid; its exact value is immaterial on the
 * surfaces that hit these cases (they re-sort by their own rule, or the bad data
 * is transient until a reseed).
 */
export function keyBetweenSafe(prev: string | null, next: string | null): string {
  let lo = isValidOrderKey(prev) ? prev : null;
  let hi = isValidOrderKey(next) ? next : null;
  if (lo !== null && hi !== null && lo >= hi) {
    [lo, hi] = lo > hi ? [hi, lo] : [lo, null];
  }
  return keyBetween(lo, hi);
}
