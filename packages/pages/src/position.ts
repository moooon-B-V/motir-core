import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import { PAGE_LEVEL_PAGE_SIZE, PAGE_LEVEL_PAGE_SIZE_MAX } from './constants';
import type { PageLevelCursor } from './types';

// Order within a level (`docs/decisions/pages.md` §4): pages carry a fractional
// key among the pages sharing their parent, and a level is read in
// `(position, id)` order with a keyset cursor on that pair.

/**
 * A key that sorts strictly between `before` and `after`; `null` means the start
 * or the end of the level. Throws when `before` does not sort before `after`.
 */
export function positionBetween(before: string | null, after: string | null): string {
  return generateKeyBetween(before, after);
}

/** `count` ascending keys between `before` and `after`, for placing several pages at once. */
export function positionsBetween(
  before: string | null,
  after: string | null,
  count: number,
): string[] {
  return generateNKeysBetween(before, after, count);
}

/**
 * The level order: by `position`, then by `id` as the tie-break. Keys compare by
 * code unit, the order `fractional-indexing` generates them in and the order
 * Postgres's `COLLATE "C"` reads them in — never `localeCompare`.
 */
export function comparePageOrder(a: PageLevelCursor, b: PageLevelCursor): number {
  if (a.position !== b.position) return a.position < b.position ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/** Whether `node` comes after `cursor` in level order — the keyset predicate. */
export function isAfterCursor(node: PageLevelCursor, cursor: PageLevelCursor): boolean {
  return comparePageOrder(node, cursor) > 0;
}

/**
 * The page size a level read uses: {@link PAGE_LEVEL_PAGE_SIZE} when none is
 * asked for, clamped to 1…{@link PAGE_LEVEL_PAGE_SIZE_MAX}.
 */
export function levelPageSize(requested?: number | null): number {
  if (requested === undefined || requested === null || !Number.isFinite(requested)) {
    return PAGE_LEVEL_PAGE_SIZE;
  }
  return Math.min(PAGE_LEVEL_PAGE_SIZE_MAX, Math.max(1, Math.floor(requested)));
}
