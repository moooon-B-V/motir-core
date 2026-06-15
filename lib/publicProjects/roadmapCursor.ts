// The public-roadmap per-column page cursor (Story 6.12 · Subtask 6.12.7). Each
// roadmap column (submitted / planned / in progress / done) is independently
// cursor-paginated — the at-scale rule: a busy public roadmap is unbounded, so
// no column ever "loads all" (finding #57). The column read orders by
// `(voteCount DESC, recency DESC, id ASC)` — the demand signal first (the same
// vote-count-leading order the 6.11.3 triage queue uses), then a per-bucket
// recency tiebreak, then the work-item `id` breaking the (rare) exact tie.
//
// `recency` is a per-bucket string: the **Submitted** column tiebreaks on
// `triagedAt` (an ISO-8601 instant — wire-safe), every **promoted** column
// (planned / in progress / done) tiebreaks on the work item's monotonic per-
// project `key` (serialised as a decimal string). The service decodes the
// string and binds it to the right typed seek-after comparison; encoding the
// (voteCount, recency, id) TUPLE — not a row offset — keeps paging stable across
// concurrent intake / voting (an offset breaks the instant a fresh vote or a new
// submission reshuffles the column head).

/**
 * The `(voteCount, recency, id)` seek-after position a roadmap-column cursor
 * decodes to — the last card of the previous page. `voteCount` is the card's
 * upvote tally (the leading sort key); `recency` is the bucket's tiebreak value
 * as a string (an ISO instant for Submitted, the decimal `key` for the promoted
 * columns); `id` is the work-item id.
 */
export interface RoadmapColumnCursorToken {
  voteCount: number;
  recency: string;
  id: string;
}

/** Per-column page size — bounded; "Load N more" pages forward (never load-all). */
export const PUBLIC_ROADMAP_PAGE_SIZE = 20;

/**
 * A caller passed a `cursor` that isn't a well-formed `base64url([voteCount,
 * recency, id])` token (bad base64, bad JSON, a non-integer / negative vote
 * count, an empty recency, or a non-string id). The route maps this to a 400 —
 * distinct from a VALID cursor pointing past the tail, which returns an empty
 * page, not an error.
 */
export class InvalidRoadmapCursorError extends Error {
  readonly code = 'INVALID_ROADMAP_CURSOR' as const;
  constructor() {
    super('Invalid public roadmap cursor.');
    this.name = 'InvalidRoadmapCursorError';
  }
}

/** Encode a `(voteCount, recency, id)` position into the opaque column cursor. */
export function encodeRoadmapCursor(cursor: RoadmapColumnCursorToken): string {
  return Buffer.from(
    JSON.stringify([cursor.voteCount, cursor.recency, cursor.id]),
    'utf8',
  ).toString('base64url');
}

/**
 * Decode the opaque column cursor back to its `(voteCount, recency, id)`
 * position. Throws {@link InvalidRoadmapCursorError} on any malformed token so
 * the route returns 400 rather than silently treating garbage as "start from the
 * top". The vote count must be a finite, non-negative integer; `recency` and
 * `id` must be non-empty strings.
 */
export function decodeRoadmapCursor(raw: string): RoadmapColumnCursorToken {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidRoadmapCursorError();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 3 ||
    typeof parsed[0] !== 'number' ||
    !Number.isInteger(parsed[0]) ||
    parsed[0] < 0 ||
    typeof parsed[1] !== 'string' ||
    parsed[1].length === 0 ||
    typeof parsed[2] !== 'string' ||
    parsed[2].length === 0
  ) {
    throw new InvalidRoadmapCursorError();
  }
  return { voteCount: parsed[0], recency: parsed[1], id: parsed[2] };
}
