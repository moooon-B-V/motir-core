import { createHmac, timingSafeEqual } from 'node:crypto';
import { InvalidRequestError } from '@/lib/api/v1/errors';

// Cursor pagination + the shared list envelope for `/api/v1` (Story 11.1 ·
// Subtask 11.1.3 — MOTIR-1859). ONE pagination shape every collection in 11.2 /
// 11.3 reuses. Pinned in `docs/decisions/public-api-conventions.md` §5.
//
// ── KEYSET, not offset ───────────────────────────────────────────────────────
// The cursor encodes a POSITION IN THE SORT ORDER, never a page number. Motir's
// collections mutate while a client pages them — an agent loop writes while
// another reads — and offset pagination silently SKIPS a row when one is
// inserted before the cursor and DUPLICATES one when a row is removed. A keyset
// cursor cannot: "everything after this key" is stable no matter what happens
// elsewhere in the set.
//
// (Deliberate divergence from `lib/mcp/searchCursor.ts`, whose cursor wraps a
// page NUMBER: that tool must page IDENTICALLY to the offset-paged List view it
// claims parity with, so an offset cursor is correct there. v1 has no such
// constraint and takes the stronger guarantee. The base64url-opaque-token IDIOM
// is shared; the semantics are not.)
//
// ── OPAQUE means UNFORGEABLE ─────────────────────────────────────────────────
// The cursor is HMAC-signed. base64url alone would be *unreadable* but still
// *constructible* by any client that guessed the shape — and a client that can
// hand-craft a cursor has made the underlying sort key public API, which turns a
// future index change into a breaking change. Signing makes "only a cursor we
// issued is valid" a property rather than a hope, and gives the foreign/tampered
// cursor case a crisp 422.

/** Page size when the caller does not ask for one. */
export const DEFAULT_PAGE_LIMIT = 50;
/** Hard ceiling — a larger `limit` is clamped down to this, not rejected. */
export const MAX_PAGE_LIMIT = 100;

/** The sort position a cursor encodes: `(createdAt, id)`, ascending. */
export interface PageCursor {
  /** ISO-8601 timestamp of the last row on the previous page. */
  createdAt: string;
  /** That row's id — the tiebreaker that makes the order TOTAL. */
  id: string;
}

/** The envelope EVERY v1 collection returns. */
export interface ListEnvelope<T> {
  items: T[];
  /** The cursor for the next page, or `null` on the last page. */
  nextCursor: string | null;
}

/** What a row must expose to be keyset-paged. */
export interface Keyed {
  id: string;
  createdAt: Date;
}

function signingKey(): string {
  // Derived from the app secret so a cursor issued by one deployment is not
  // valid against another, and so nothing else that uses the secret shares
  // this signature space.
  const secret = process.env['BETTER_AUTH_SECRET'];
  if (!secret) throw new Error('BETTER_AUTH_SECRET is not set');
  return `${secret}:api-v1-cursor`;
}

function sign(payload: string): string {
  return createHmac('sha256', signingKey()).update(payload).digest('base64url');
}

/** Encode a keyset position into the opaque, signed cursor. */
export function encodePageCursor(cursor: PageCursor): string {
  const payload = Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/**
 * Decode a cursor back to its keyset position.
 *
 * Throws a 422 {@link InvalidRequestError} for anything that is not a cursor we
 * issued — malformed, truncated, tampered, or from another deployment. It never
 * falls back to "start from the top": a silent reset to page one is the failure
 * mode that makes a client loop forever over the first page.
 */
export function decodePageCursor(raw: string): PageCursor {
  const invalid = () =>
    new InvalidRequestError('INVALID_CURSOR', 'The `cursor` parameter is not a valid page cursor.');

  const dot = raw.lastIndexOf('.');
  if (dot <= 0 || dot === raw.length - 1) throw invalid();
  const payload = raw.slice(0, dot);
  const presented = Buffer.from(raw.slice(dot + 1), 'base64url');
  const expected = Buffer.from(sign(payload), 'base64url');
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    throw invalid();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as PageCursor).id !== 'string' ||
    typeof (parsed as PageCursor).createdAt !== 'string' ||
    Number.isNaN(Date.parse((parsed as PageCursor).createdAt))
  ) {
    throw invalid();
  }
  return { createdAt: (parsed as PageCursor).createdAt, id: (parsed as PageCursor).id };
}

/** A validated `?cursor=&limit=` pair. */
export interface PageRequest {
  limit: number;
  cursor: PageCursor | undefined;
}

/**
 * Parse and validate `?cursor=&limit=` off a request.
 *
 * `limit` defaults to {@link DEFAULT_PAGE_LIMIT} and is CLAMPED down to
 * {@link MAX_PAGE_LIMIT} — asking for more than the ceiling is a reasonable
 * request answered with the ceiling. `0`, a negative, a fractional and a
 * non-numeric value are each REJECTED with 422 rather than coerced: silently
 * turning `limit=0` into 50 hands the caller a page they did not ask for and
 * hides their bug.
 */
export function parsePageRequest(req: Request): PageRequest {
  const params = new URL(req.url).searchParams;

  const rawLimit = params.get('limit');
  let limit = DEFAULT_PAGE_LIMIT;
  if (rawLimit !== null && rawLimit !== '') {
    if (!/^\d+$/.test(rawLimit)) {
      throw new InvalidRequestError(
        'INVALID_LIMIT',
        'The `limit` parameter must be a positive integer.',
      );
    }
    const parsed = Number(rawLimit);
    if (parsed < 1) {
      throw new InvalidRequestError(
        'INVALID_LIMIT',
        'The `limit` parameter must be a positive integer.',
      );
    }
    limit = Math.min(parsed, MAX_PAGE_LIMIT);
  }

  const rawCursor = params.get('cursor');
  const cursor = rawCursor !== null && rawCursor !== '' ? decodePageCursor(rawCursor) : undefined;

  return { limit, cursor };
}

/**
 * Take one keyset page out of a fully-read collection and shape the envelope.
 *
 * The rows are sorted `(createdAt, id)` ascending — a TOTAL order, so the
 * position is unambiguous even when timestamps collide — and the page is
 * "everything strictly after the cursor". That is what gives the no-skip /
 * no-duplicate guarantee: a row inserted before the cursor between two fetches
 * is not re-shown (it was never on an earlier page under this order), and a row
 * inserted after it simply arrives on a later page.
 *
 * `map` shapes each row into its wire DTO, so the sort key stays internal.
 */
export function paginateKeyset<TRow extends Keyed, TItem>(
  rows: readonly TRow[],
  page: PageRequest,
  map: (row: TRow) => TItem,
): ListEnvelope<TItem> {
  const ordered = [...rows].sort(compareKeys);

  const start = page.cursor
    ? ordered.findIndex((row) => isAfter(row, page.cursor as PageCursor))
    : 0;
  // A cursor past the tail (every row is at or before it) yields an empty final
  // page rather than an error — it is a VALID position, just an exhausted one.
  const from = start === -1 ? ordered.length : start;

  const slice = ordered.slice(from, from + page.limit);
  const last = slice[slice.length - 1];
  const hasMore = from + slice.length < ordered.length;

  return {
    items: slice.map(map),
    nextCursor:
      hasMore && last
        ? encodePageCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null,
  };
}

function compareKeys(a: Keyed, b: Keyed): number {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
}

/** Is `row` strictly after the cursor position in `(createdAt, id)` order? */
function isAfter(row: Keyed, cursor: PageCursor): boolean {
  const rowTime = row.createdAt.getTime();
  const cursorTime = Date.parse(cursor.createdAt);
  if (rowTime !== cursorTime) return rowTime > cursorTime;
  return row.id.localeCompare(cursor.id) > 0;
}
