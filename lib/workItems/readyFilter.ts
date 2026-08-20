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

// ⚠️ `import type`, NEVER a value import — and this line is load-bearing rather
// than stylistic (MOTIR-2458, re-learned here by MOTIR-3196).
//
// A generated enum is a runtime VALUE, so `import { WorkItemKind } from
// '@/generated/prisma/client'` pulls the whole `@prisma/client` runtime into
// every module graph that reaches this file. This file used to do exactly that,
// and it did not matter for as long as its only consumers were services that
// carry the client anyway. Then `lib/api/v1/ready/schema.ts` — reached by the
// OpenAPI operation registry, which three PUBLISHED documentation pages render
// — began importing a VALUE from here (`SPRINT_ACTIVE`), and those three pages
// shipped a database client to draw a schema table. That is the same failure
// MOTIR-2458 fixed one module over, arriving through one extra hop.
//
// `tests/public-docs-db-imports.test.ts` is the guard, and it fails on the
// PAGES rather than on this line — so if it ever goes red again, the reach is
// what to look for, not the page.
//
// The two vocabularies below are therefore literal tuples with a compile-time
// totality assertion, exactly as `ready/schema.ts` derives its own. The Prisma
// enums remain the upstream authority for what they must contain; the assertion
// is what makes that a compile error rather than a comment.
import type { WorkItemKind, WorkItemPriority } from '@/generated/prisma/client';

/** `true` only when `Union` is fully covered by `Covered`; otherwise `never`. */
type AssertTotal<Union, Covered> = [Exclude<Union, Covered>] extends [never] ? true : never;

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
  /**
   * SCOPE to the ready leaves STRICTLY BENEATH these container keys, at any
   * depth — an any-of set, exactly like `kinds` (Story MOTIR-3001 · MOTIR-3196).
   *
   * ⚠️ These are unresolved `MOTIR-<n>` KEYS, not ids, and that is the one axis
   * on this shape that cannot validate itself. `kinds` / `priority` are closed
   * vocabularies a parser settles alone; a key is a REFERENCE, and whether it
   * names a container in THIS project is a database question. So the ready
   * SERVICE resolves it and raises {@link InvalidReadyFilterError} — the same
   * split {@link InvalidReadyCursorError} already uses for a token only the
   * codec can judge.
   *
   * The named container is NOT in its own result: the answer to "what is ready
   * under this story" never includes the story. A childless one therefore
   * returns an empty page, which is the honest answer for a story nobody has
   * decomposed yet.
   */
  ancestorKeys?: string[];
  /**
   * SCOPE to the items whose OWN `sprintId` is this sprint — an id, or the
   * reserved literal {@link SPRINT_ACTIVE} for the project's active one.
   *
   * SINGLE-VALUED because membership is a scalar column on the row: an item is
   * in one sprint or none, so an any-of set would be a shape with no question
   * behind it. Resolved by the service, like `ancestorKeys` above.
   *
   * Membership is DIRECT, never inherited — an item under an in-sprint parent
   * but not itself in the sprint is out of scope. That is the same scoping
   * `claimNextReady` has applied internally since it shipped
   * (`ready.filter((r) => r.sprintId === sprintId)`), published rather than
   * re-derived.
   */
  sprintRef?: string;
  /** Opaque `base64url([kind, priority, key])` seek-after token. */
  cursor?: string;
  /** Page size; defaults to 50, hard-capped at 200. */
  limit?: number;
}

/**
 * The literal a caller sends as `sprintRef` to mean "the project's ACTIVE
 * sprint".
 *
 * A sprint id is opaque, so a caller who wants the current sprint would
 * otherwise have to read the sprint list first purely to learn one id — and
 * then race the very activation they were asking about. The reserved literal is
 * the same device `UNASSIGNED = 'none'` is on `assigneeId`: a value the wire
 * form cannot otherwise carry, spelled once.
 *
 * It cannot collide with a real id: sprint ids are cuids, which are
 * `c`-prefixed and 25 characters long.
 */
export const SPRINT_ACTIVE = 'active';

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

/**
 * A caller passed a `ancestorKeys` / `sprintRef` value that does not RESOLVE
 * inside the project being read: an unknown work-item key, a key belonging to
 * another project or workspace, a sprint id that is not this project's, or
 * `sprintRef: 'active'` on a project that is between sprints. The route layer
 * maps this to `INVALID_READY_FILTER` → 422, the same code
 * `parseReadyFilters` already raises for an unknown `kind` / `priority`.
 *
 * ⚠️ A REFUSAL, NEVER A SILENT MATCH-EVERYTHING. The whole point of the two
 * scope facets is that a caller is about to CLAIM and DISPATCH what comes back;
 * a mistyped key that quietly widened the scope to the entire project is how a
 * run takes work it meant to exclude. The three existing facets already refuse
 * for exactly this reason and this is the same rule one tier down.
 *
 * ⚠️ AND IT DOES NOT DISTINGUISH "unknown" FROM "somebody else's". A key that
 * resolves in another project reaches the same refusal with the same message as
 * one that never existed — the existence-oracle rule
 * (`docs/decisions/public-api-conventions.md` §4). That falls out of the
 * mechanism rather than being asserted on top of it:
 * `workItemRepository.findByIdentifiers` is project-scoped, so a foreign key is
 * simply absent from the result.
 */
export class InvalidReadyFilterError extends Error {
  readonly code = 'INVALID_READY_FILTER' as const;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidReadyFilterError';
  }
}

// The enum's declaration order IS the priority ranking (lowest → highest); the
// sort reverses it (highest first). Kept as a frozen tuple for the rare JS-side
// comparison; the SQL seek-after compares the enum column directly.
export const READY_PRIORITY_ASC = [
  'lowest',
  'low',
  'medium',
  'high',
  'highest',
] as const satisfies readonly WorkItemPriority[];
const _prioritiesTotal: AssertTotal<WorkItemPriority, (typeof READY_PRIORITY_ASC)[number]> = true;

const PRIORITY_VALUES = new Set<string>(READY_PRIORITY_ASC);

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
  subtask: 0,
  bug: 1,
  task: 2,
  story: 3,
  epic: 4,
};
// `Record<WorkItemKind, number>` already makes a MISSING kind a compile error;
// this makes an EXTRA one a compile error too, which the Record does not.
const _kindsTotal: AssertTotal<WorkItemKind, keyof typeof READY_KIND_RANK> = true;

const KIND_VALUES = new Set<string>(Object.keys(READY_KIND_RANK));

void [_kindsTotal, _prioritiesTotal];

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
