import { InvalidProjectSquareCursorError } from '@/lib/projectSquare/errors';
import {
  parseRank,
  parseTrendingWindow,
  type ProjectSquareRank,
  type TrendingWindow,
} from '@/lib/projectSquare/rank';

// Opaque keyset cursor for the RANKED project-square directory (Story 6.13 ·
// Subtask 6.13.4). Each rank is a DETERMINISTIC total order with a stable `id`
// tiebreak, so a page's cursor carries the last row's sort key + its id:
//
//   • trending / popular → an integer `score` (+ id)
//   • recent             → an ISO-8601 `ts` (the COALESCE(madePublicAt,
//     createdAt) value) (+ id)
//
// The cursor ALSO pins the `rank` (and, for trending, the `window`) it was
// minted under — AND, since Subtask 6.13.3, the active search query + category
// NARROWING — so the service can reject a cursor replayed against a DIFFERENT
// rank/window/search/category: switching tabs OR changing the search/filter must
// restart pagination, never seek into a set the value was never computed in. A
// tampered/cross-view token decodes to {@link InvalidProjectSquareCursorError} →
// the route answers 400 rather than silently resetting to page 1 (which would
// mask a client bug).
//
// Encoded as base64url(JSON) — a single URL-safe opaque token the client never
// parses.

export interface RankedDirectoryCursor {
  rank: ProjectSquareRank;
  /** The trending window the score was computed under; null for popular/recent. */
  window: TrendingWindow | null;
  /** The numeric sort key for trending/popular; null for recent. */
  score: number | null;
  /** The ISO-8601 sort key for recent; null for trending/popular. */
  ts: string | null;
  /** The last row's id — the stable keyset tiebreak. */
  id: string;
  /**
   * The 6.13.3 NARROWING the page was minted under — the normalized search query
   * (null when unfiltered) and the category slug (null when unfiltered). A
   * search/category narrows the SET but not the ORDER, so the keyset still seeks
   * correctly within a CONSISTENT narrowing; but a cursor REPLAYED under a
   * DIFFERENT narrowing would seek into a set the score was never computed in, so
   * the service rejects the mismatch and the client restarts paging — the same
   * "changing the view restarts pagination" posture rank/window already enforce.
   */
  search: string | null;
  category: string | null;
}

/** Encode a ranked keyset position into the opaque page token. */
export function encodeRankedCursor(cursor: RankedDirectoryCursor): string {
  const json = JSON.stringify({
    r: cursor.rank,
    w: cursor.window,
    s: cursor.score,
    t: cursor.ts,
    i: cursor.id,
    q: cursor.search,
    c: cursor.category,
  });
  return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * Decode an opaque ranked page token back into its keyset position, throwing
 * {@link InvalidProjectSquareCursorError} on anything that is not a well-formed
 * ranked cursor: bad base64/JSON, an unknown rank/window, the wrong score/ts
 * shape for the rank, or a missing id. The service additionally checks the
 * decoded rank/window match the REQUESTED ones.
 */
export function decodeRankedCursor(raw: string): RankedDirectoryCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidProjectSquareCursorError();
  }
  if (typeof parsed !== 'object' || parsed === null) throw new InvalidProjectSquareCursorError();
  const obj = parsed as Record<string, unknown>;

  const rank = typeof obj.r === 'string' ? parseRank(obj.r) : null;
  if (!rank) throw new InvalidProjectSquareCursorError();

  // window: null for popular/recent; a valid window for trending.
  let window: TrendingWindow | null = null;
  if (rank === 'trending') {
    window = typeof obj.w === 'string' ? parseTrendingWindow(obj.w) : null;
    if (!window) throw new InvalidProjectSquareCursorError();
  } else if (obj.w !== null && obj.w !== undefined) {
    throw new InvalidProjectSquareCursorError();
  }

  if (typeof obj.i !== 'string' || obj.i.length === 0) throw new InvalidProjectSquareCursorError();

  // The 6.13.3 narrowing the cursor was minted under: each is a string or null
  // (absent → null, the unfiltered page). Any other type is a tampered token.
  const search = nullableString(obj.q);
  const category = nullableString(obj.c);

  if (rank === 'recent') {
    // Recent rides a timestamp key; reject a non-ISO / unparseable ts.
    if (typeof obj.t !== 'string' || Number.isNaN(new Date(obj.t).getTime())) {
      throw new InvalidProjectSquareCursorError();
    }
    if (obj.s !== null && obj.s !== undefined) throw new InvalidProjectSquareCursorError();
    return { rank, window, score: null, ts: obj.t, id: obj.i, search, category };
  }

  // trending / popular ride a numeric score key.
  if (typeof obj.s !== 'number' || !Number.isFinite(obj.s)) {
    throw new InvalidProjectSquareCursorError();
  }
  if (obj.t !== null && obj.t !== undefined) throw new InvalidProjectSquareCursorError();
  return { rank, window, score: obj.s, ts: null, id: obj.i, search, category };
}

/**
 * Coerce an optional cursor field to `string | null`: `undefined`/`null` → null
 * (the unfiltered narrowing), a string → itself, anything else → a tampered
 * token ({@link InvalidProjectSquareCursorError}).
 */
function nullableString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  throw new InvalidProjectSquareCursorError();
}
