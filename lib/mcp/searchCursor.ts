// The `search_work_items` page cursor (Story 7.8 · Subtask 7.8.6). The tool
// wraps the SAME read the `/issues` List view rides
// (`workItemsService.getProjectIssuesList`), which is LIMIT/OFFSET-paged by a
// 1-based page number (Subtask 2.5.12). To present the cursor surface the
// sibling read tools (`list_ready`, 7.8.4) and the AC use — `cursor` in,
// `nextCursor` out — we wrap that page number in an OPAQUE token rather than
// inventing a second query path (rung 2: reuse the shipped read; the mirror's
// JQL search is `startAt`-paged too, so an offset cursor is faithful).
//
// The token is deliberately just `base64url({ page })`: an offset pager over a
// live set isn't seek-stable across inserts/removes, but that is EXACTLY the
// shipped List's contract — the tool must page identically to the surface it
// claims parity with, not better. Decoding a malformed token throws so the tool
// returns a clean error rather than silently restarting at page 1 (the same
// discipline as `decodeReadyCursor`).

/** The page position a search cursor decodes to — the 1-based page to fetch. */
export interface SearchCursor {
  page: number;
}

/**
 * A caller passed a `cursor` that isn't a well-formed `base64url({ page })`
 * token (bad base64, bad JSON, or a non-integer / `< 1` page). The tool maps
 * this to a clean `isError` result. Distinct from a VALID cursor that points
 * past the tail — that returns an empty page, not an error (parity with
 * `decodeReadyCursor` / `InvalidReadyCursorError`).
 */
export class InvalidSearchCursorError extends Error {
  readonly code = 'INVALID_SEARCH_CURSOR' as const;
  constructor() {
    super('Invalid search cursor.');
    this.name = 'InvalidSearchCursorError';
  }
}

/** Encode a 1-based page index into the opaque page cursor. */
export function encodeSearchCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify({ page: cursor.page }), 'utf8').toString('base64url');
}

/**
 * Decode the opaque page cursor back to its 1-based page. Throws
 * {@link InvalidSearchCursorError} on any malformed token so the tool surfaces
 * a clean error rather than treating garbage as "start from the top".
 */
export function decodeSearchCursor(raw: string): SearchCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidSearchCursorError();
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { page?: unknown }).page !== 'number' ||
    !Number.isInteger((parsed as { page: number }).page) ||
    (parsed as { page: number }).page < 1
  ) {
    throw new InvalidSearchCursorError();
  }
  return { page: (parsed as { page: number }).page };
}
