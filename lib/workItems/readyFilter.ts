// The ready-set filter + cursor codec (Subtask 7.0.2 — the AI dispatch
// surface's service layer). `listReady` / `getNextReady` and the two
// `/api/ready*` endpoints (7.0.4 / 7.0.5) share this one filter shape and the
// one opaque cursor format, so the page and the BYOK agent always agree on
// what "ready" means and how to page through it.
//
// The sort the cursor encodes is the deterministic `(type asc, priority desc,
// key asc)` (Story 7.0 + Subtask 7.0.12, reversing 7.0.11's precedence): NOT
// random, NOT created-at, NOT updated-at — those leak dispatch decisions to
// scheduling artifacts the planner can't audit. **Type is primary** in the
// fixed dispatch order `subtask < bug < task < story < epic` (the leaf-most,
// most-granular unit first — coherent with 7.0.10's leaf-only ready set);
// **priority breaks the type tie** (highest first, within a type bucket); `key`
// breaks the final tie. Encoding the (kind, priority, key) TUPLE (not a row
// offset) is what makes paging stable across a `db:seed` reseed — an offset
// over a live set breaks the moment a row is inserted/removed, but the
// seek-after position is reproducible.

import { WorkItemKind, WorkItemPriority } from '@prisma/client';

/**
 * The faceted filter every ready read accepts. Each axis is optional and
 * AND-ed with the rest. `kinds` / `priority` are "any of" sets; `assigneeId`
 * is tri-state — `undefined` = any assignee, `null` = the UNASSIGNED bucket, a
 * string = that user's items. `cursor` is the opaque seek-after token from a
 * previous page; `limit` is clamped into `[1, READY_MAX_LIMIT]` (default
 * `READY_DEFAULT_LIMIT`).
 */
export interface ReadyListFilter {
  kinds?: WorkItemKind[];
  /** `null` = unassigned only; `undefined` = any assignee. */
  assigneeId?: string | null;
  priority?: WorkItemPriority[];
  /** Opaque `base64url([kind, priority, key])` seek-after token. */
  cursor?: string;
  /** Page size; defaults to 50, hard-capped at 200. */
  limit?: number;
}

export const READY_DEFAULT_LIMIT = 50;
export const READY_MAX_LIMIT = 200;

/**
 * Bounds for the sidebar READY-COUNT badge (Subtask 7.0.6). Readiness is a
 * COMPUTED predicate (per-blocker, finding #21 — not a stored column), so an
 * exact count means examining every candidate. The badge renders on EVERY
 * authed route, so the count scan is doubly bounded: it stops once it has
 * counted `READY_COUNT_CAP` ready items (the badge then shows "{cap}+", the
 * universal nav-badge cap) AND after at most `READY_COUNT_MAX_PAGES` candidate
 * pages. Either bound short-circuiting sets `hasMore` so the cap is VISIBLE,
 * never a silent truncation. (A future materialized readiness flag would make
 * this O(1); logged as a finding.)
 */
export const READY_COUNT_CAP = 99;
export const READY_COUNT_MAX_PAGES = 10;

/**
 * The (kind, priority, key) seek-after position a ready cursor decodes to — the
 * last candidate of the previous page under the `(type asc, priority desc, key
 * asc)` sort. `kind` is the issue type, ranked by {@link READY_KIND_RANK}
 * (`subtask` first … `epic` last) — the PRIMARY key; `priority` breaks the type
 * tie; `key` is the per-project numeric `work_item.key` (monotonic, stable
 * across reseed, NOT the `PROD-<n>` identifier string) and breaks the final tie.
 */
export interface ReadyCursor {
  kind: WorkItemKind;
  priority: WorkItemPriority;
  key: number;
}

/**
 * A caller passed a `cursor` that isn't a well-formed `base64url([kind,
 * priority, key])` token (bad base64, bad JSON, unknown kind, unknown priority,
 * or a non-integer key). The route layer (7.0.4) maps this to a 400. Distinct from
 * a VALID cursor that simply points past the tail — that returns an empty page,
 * not an error.
 */
export class InvalidReadyCursorError extends Error {
  readonly code = 'INVALID_READY_CURSOR' as const;
  constructor() {
    super('Invalid ready cursor.');
    this.name = 'InvalidReadyCursorError';
  }
}

// The enum's declaration order IS the priority ranking (lowest → highest); the
// sort reverses it (highest first). Kept as a frozen tuple for the rare JS-side
// comparison; the SQL seek-after compares the enum column directly.
export const READY_PRIORITY_ASC: readonly WorkItemPriority[] = [
  WorkItemPriority.lowest,
  WorkItemPriority.low,
  WorkItemPriority.medium,
  WorkItemPriority.high,
  WorkItemPriority.highest,
];

const PRIORITY_VALUES = new Set<string>(Object.values(WorkItemPriority));

/**
 * The issue-type dispatch ranking — the PRIMARY sort key (Subtask 7.0.12;
 * priority is now the secondary tie-breaker within a type bucket). The ready set
 * surfaces the most granular, leaf-most work first (`subtask`), coarsening to
 * the container kinds last (`epic`), so a coding agent reaching for `next` gets
 * a runnable unit before a planning container. This is the single source of the
 * order; the repository builds its `ORDER BY` CASE rank from these same values.
 * (A childed epic/story is excluded entirely by 7.0.10's leaf-only predicate;
 * this orders what remains.)
 */
export const READY_KIND_RANK: Record<WorkItemKind, number> = {
  [WorkItemKind.subtask]: 0,
  [WorkItemKind.bug]: 1,
  [WorkItemKind.task]: 2,
  [WorkItemKind.story]: 3,
  [WorkItemKind.epic]: 4,
};

const KIND_VALUES = new Set<string>(Object.values(WorkItemKind));

/** Encode a (kind, priority, key) position into the opaque page cursor. */
export function encodeReadyCursor(cursor: ReadyCursor): string {
  return Buffer.from(JSON.stringify([cursor.kind, cursor.priority, cursor.key]), 'utf8').toString(
    'base64url',
  );
}

/**
 * Decode the opaque page cursor back to its (kind, priority, key) position.
 * Throws {@link InvalidReadyCursorError} on any malformed token so the route
 * returns 400 rather than silently treating garbage as "start from the top".
 */
export function decodeReadyCursor(raw: string): ReadyCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidReadyCursorError();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 3 ||
    typeof parsed[0] !== 'string' ||
    !KIND_VALUES.has(parsed[0]) ||
    typeof parsed[1] !== 'string' ||
    !PRIORITY_VALUES.has(parsed[1]) ||
    typeof parsed[2] !== 'number' ||
    !Number.isInteger(parsed[2])
  ) {
    throw new InvalidReadyCursorError();
  }
  return {
    kind: parsed[0] as WorkItemKind,
    priority: parsed[1] as WorkItemPriority,
    key: parsed[2],
  };
}

/**
 * Clamp a caller-supplied limit into `[1, READY_MAX_LIMIT]`. A missing or
 * non-positive / non-finite value falls back to `READY_DEFAULT_LIMIT`; an
 * over-cap value is clamped DOWN (the endpoints clamp silently rather than
 * 400, which is friendlier for a CLI).
 */
export function clampReadyLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) return READY_DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), READY_MAX_LIMIT);
}
