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
  const limit = parseLimitParam(params);

  const rawCursor = params.get('cursor');
  const cursor = rawCursor !== null && rawCursor !== '' ? decodePageCursor(rawCursor) : undefined;

  return { limit, cursor };
}

/**
 * The `?limit=` half of {@link parsePageRequest}, on its own.
 *
 * Extracted so the collection-scoped parser below applies the IDENTICAL rules
 * rather than a second copy of them — v1's ceiling is a promise in the ADR (§5),
 * and two implementations of one promise is how one of them drifts.
 */
function parseLimitParam(params: URLSearchParams): number {
  const rawLimit = params.get('limit');
  if (rawLimit === null || rawLimit === '') return DEFAULT_PAGE_LIMIT;

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
  return Math.min(parsed, MAX_PAGE_LIMIT);
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

// ─────────────────────────────────────────────────────────────────────────────
// The COLLECTION-SCOPED cursor over a SERVICE-OWNED position
// (Story 11.3 · Subtask 11.3.2 — MOTIR-2059)
// ─────────────────────────────────────────────────────────────────────────────
//
// Everything above encodes ONE order: `(createdAt, id)`. That is the right order
// for 11.1's and 11.2's collections and the WRONG one for every collection in
// Story 11.3 — the backlog and a sprint's members are ordered by `backlogRank`,
// the ready set by the `(type asc, priority desc, key asc)` DISPATCH rank, a
// project's sprints by `sequence`. Two of the DTOs involved cannot even satisfy
// `Keyed`: `SprintDto` has no `createdAt`, and `ProjectDTO.createdAt` is optional
// and deliberately unloaded on the list path.
//
// So the cursor below wraps a position the SERVICE owns — the token the
// underlying read already speaks — instead of one v1 invented. ADR Amendment 3
// (Q1) is the contract; the three properties §5 gives the cursor are unchanged
// and are the reason this is safe:
//
//   • KEYSET — the payload is a seek-after POSITION in the collection's own
//     order, never a page number or a row offset.
//   • OPAQUE — the SAME HMAC construction and the SAME `BETTER_AUTH_SECRET`-
//     derived key as `encodePageCursor`. This is exactly what licenses the
//     generalization: the wrapped position may be any service token precisely
//     because nobody outside the server can read or forge one.
//   • A BAD CURSOR IS A 422, NEVER A SILENT RESET — including the new case
//     below.
//
// ⚠️ COLLECTION-SCOPED, and that is the load-bearing addition. The backlog's
// position and a sprint member's position are BOTH a bare row id: structurally
// identical, so without a scope one would decode cleanly into the other and
// return a page positioned by a row that is not in that collection at all — a
// silently wrong page, which is worse than the refusal §5 already prescribes for
// a foreign cursor. The narrower `(createdAt, id)` shape never had this problem
// because every collection shared one order.

/** The collections that issue a service-positioned cursor. */
export const V1_COLLECTIONS = [
  'projects',
  'sprints',
  'backlog',
  'sprintWorkItems',
  'ready',
  // Story 11.7's activity read, ONE NAME PER VIEW. The three views page over
  // different sources — the `all` view's cursor is an OPAQUE COMPOSITE carrying
  // both positions — so a cursor issued for one view and handed to another must
  // be REFUSED rather than decoded into a meaningless position. Sharing one
  // collection name across the three would decode cleanly and seek nowhere,
  // which is the silent-reset failure §5 exists to forbid.
  'workItemActivityAll',
  'workItemActivityComments',
  'workItemActivityHistory',
] as const;

/** The name a cursor carries so it can only be replayed at its own collection. */
export type V1Collection = (typeof V1_COLLECTIONS)[number];

/**
 * The list envelope PLUS the total behind it — the one documented variant
 * (ADR Amendment 3, Q2).
 *
 * Returned ONLY by collections whose shipped read already computes the count as
 * a bounded aggregate: the backlog and a sprint's members, both of which get it
 * from `RankedIssuePageDto`. Every other collection returns {@link ListEnvelope}
 * and omits the field entirely — absent, never `null` and never `0`, because a
 * `null` a client cannot distinguish from a real answer is a shape that lies.
 *
 * Declared HERE, beside `ListEnvelope`, so Story 11.4 emits two named envelope
 * schemas from one place rather than rediscovering the split per endpoint.
 */
export interface RankedListEnvelope<T> extends ListEnvelope<T> {
  totalCount: number;
}

/** The signed payload: which collection issued this, and the position it names. */
interface CollectionCursorPayload {
  /** The issuing collection. */
  c: string;
  /** The service-owned position, whatever shape that service speaks. */
  p: unknown;
}

function invalidCursor(): InvalidRequestError {
  // The SAME code a tampered token gets. A client cannot fix either by
  // inspecting the cursor (it is opaque by construction), so distinguishing
  // "forged" from "presented to the wrong collection" would only tell an
  // attacker which half of the check they failed.
  return new InvalidRequestError(
    'INVALID_CURSOR',
    'The `cursor` parameter is not a valid page cursor.',
  );
}

/**
 * Issue an opaque cursor naming `position` within `collection`.
 *
 * `position` is whatever the underlying read takes back — a row id for the
 * rank-ordered collections, a `(kind, priority, key)` tuple for the ready set, a
 * `sequence` for sprints. It is JSON-serialised, so it must be JSON-safe; a
 * `Date` is a caller error, exactly as it is for {@link encodePageCursor}.
 */
export function encodeCollectionCursor(collection: V1Collection, position: unknown): string {
  const payload = Buffer.from(
    JSON.stringify({ c: collection, p: position } satisfies CollectionCursorPayload),
    'utf8',
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/**
 * Read a cursor back, or raise the v1 422.
 *
 * Three checks, in this order, because each is meaningless without the one
 * before it:
 *
 *   1. The SIGNATURE verifies — so the payload is one we issued and has not been
 *      edited. A cursor from another deployment fails here, because the signing
 *      key is derived from that deployment's own secret.
 *   2. The COLLECTION matches — so a cursor cannot be replayed against a
 *      different collection whose positions happen to have the same shape.
 *   3. `readPosition` accepts the payload — so a cursor whose signature is
 *      genuine but whose position is not one this collection can use (an older
 *      release's shape, a hand-rolled test fixture) is refused rather than fed
 *      to a read that would do something undefined with it.
 *
 * Every failure is the same 422 and NEVER a fall back to "start from the top":
 * a silent reset is the failure mode that makes a client loop forever over the
 * first page.
 */
export function decodeCollectionCursor<T>(
  raw: string,
  collection: V1Collection,
  readPosition: (position: unknown) => T | undefined,
): T {
  const dot = raw.lastIndexOf('.');
  if (dot <= 0 || dot === raw.length - 1) throw invalidCursor();

  const payload = raw.slice(0, dot);
  const presented = Buffer.from(raw.slice(dot + 1), 'base64url');
  const expected = Buffer.from(sign(payload), 'base64url');
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    throw invalidCursor();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  if (typeof parsed !== 'object' || parsed === null) throw invalidCursor();

  const { c, p } = parsed as CollectionCursorPayload;
  if (c !== collection) throw invalidCursor();

  const position = readPosition(p);
  if (position === undefined) throw invalidCursor();
  return position;
}

/** A validated `?cursor=&limit=` pair for a service-positioned collection. */
export interface CollectionPageRequest<T> {
  limit: number;
  cursor: T | undefined;
}

/**
 * Parse `?cursor=&limit=` for a service-positioned collection.
 *
 * The `limit` rules are {@link parsePageRequest}'s, unchanged and shared rather
 * than re-implemented: default 50, clamp DOWN to {@link MAX_PAGE_LIMIT}, and
 * 422 on `0`, a negative, a fractional or a non-numeric value.
 *
 * ⚠️ The clamp is v1's OWN ceiling and is applied BEFORE the service sees the
 * number, so an underlying read that permits more does not raise it — the ready
 * set's `clampReadyLimit` allows 200, and a v1 caller asking for 200 gets 100.
 * ADR §5 documents 100 and Amendment 1 already forbids v1 raising an existing
 * cap; this is the mirror obligation.
 */
export function parseCollectionPageRequest<T>(
  req: Request,
  collection: V1Collection,
  readPosition: (position: unknown) => T | undefined,
): CollectionPageRequest<T> {
  const params = new URL(req.url).searchParams;
  const limit = parseLimitParam(params);

  const rawCursor = params.get('cursor');
  const cursor =
    rawCursor !== null && rawCursor !== ''
      ? decodeCollectionCursor(rawCursor, collection, readPosition)
      : undefined;

  return { limit, cursor };
}

/**
 * The position reader for a collection whose cursor is an opaque ROW ID — the
 * backlog and a sprint's members, both of which hand `backlogService` the last
 * id of the previous page.
 *
 * Shared so the two collections cannot disagree about what a valid id looks
 * like; the collection SCOPE, not the shape, is what keeps their cursors apart.
 */
export function readRowIdPosition(position: unknown): string | undefined {
  return typeof position === 'string' && position.length > 0 ? position : undefined;
}

/**
 * Take one page out of a bounded collection the service has already read and
 * ordered, seeking after a scalar POSITION.
 *
 * For the collections whose whole list is small and already ordered by the
 * service — a workspace's projects, a project's sprints — where re-deriving the
 * order in the database would mean re-implementing the read. `paginateKeyset`
 * cannot serve them: it imposes its OWN `(createdAt, id)` sort, which would
 * discard the order the service returned.
 *
 * This is still a KEYSET seek, not an offset: the page is "everything strictly
 * after the row at this position IN THE SERVICE'S ORDER", so a row inserted
 * before the cursor between two fetches does not shift the page.
 *
 * A cursor naming a row that is no longer in the collection (it was archived or
 * moved between pages) yields an EMPTY FINAL page — the same answer
 * `paginateKeyset` gives for a cursor past the tail, and deliberately not a
 * silent restart at the top, which is the failure mode ADR §5 rejects.
 */
export function paginateAtPosition<TRow, TPos, TItem>(
  rows: readonly TRow[],
  page: CollectionPageRequest<TPos>,
  collection: V1Collection,
  positionOf: (row: TRow) => TPos,
  map: (row: TRow) => TItem,
): ListEnvelope<TItem> {
  const from =
    page.cursor === undefined
      ? 0
      : rows.findIndex((row) => positionOf(row) === page.cursor) + 1 || rows.length;

  const slice = rows.slice(from, from + page.limit);
  const last = slice[slice.length - 1];
  const hasMore = from + slice.length < rows.length;

  return {
    items: slice.map(map),
    nextCursor:
      hasMore && last !== undefined ? encodeCollectionCursor(collection, positionOf(last)) : null,
  };
}
