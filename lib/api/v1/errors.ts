// The `/api/v1` error envelope (Story 11.1 · Subtask 11.1.2 — MOTIR-1858).
//
// ONE failure shape for the whole public API: `{ code, error }` plus the HTTP
// status — the convention `app/api/work-items/[id]/route.ts` already
// established, kept rather than forked (a second error shape means every client
// writes two parsers). Pinned in `docs/decisions/public-api-conventions.md` §4.
//
//   `code`  — a STABLE machine identifier. SCREAMING_SNAKE_CASE, never
//             localized, never reworded, never re-purposed. Clients branch on
//             it, so changing one is a breaking change.
//   `error` — a human sentence for a developer reading a terminal. Reworded
//             freely; nothing may parse it.
//
// The one deliberate exception is 500: an unexpected fault carries NO `code`
// (there is no stable contract for it), no stack, and no driver text. See
// `INTERNAL_ERROR_BODY`.

/** The wire body of a v1 failure. */
export interface ApiV1ErrorBody {
  code: string;
  error: string;
}

/**
 * An error the v1 wrapper knows how to render: it carries its own stable code
 * and HTTP status. Thrown by the wrapper itself (auth, scope, rate limit) and
 * by v1-layer parsing (an invalid cursor or limit); a route may throw one too
 * when the condition is an HTTP-shaped one with no domain error behind it.
 */
export class ApiV1Error extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiV1Error';
  }
}

/**
 * 401 — no token, malformed header, unknown token, revoked token, expired
 * token. All five produce THIS error with THIS message: the response never
 * distinguishes them.
 *
 * That is deliberate and load-bearing. Telling a caller which case applies
 * turns the endpoint into a token oracle — a probe that answers "does this
 * secret exist?" and "is it merely expired?". The shipped bearer gate already
 * refuses to distinguish them (`lib/apiTokens/routeAuth.ts` maps invalid /
 * revoked / expired to one `unauthenticated` reason); v1 matches it, and the
 * tests assert the five cases against ONE shared expectation so a future
 * "helpful" message cannot silently re-open the oracle.
 */
export class UnauthenticatedError extends ApiV1Error {
  constructor() {
    super('UNAUTHENTICATED', 401, 'Authentication required.');
    this.name = 'UnauthenticatedError';
  }
}

/**
 * 403 — a VALID token whose granted scopes do not include the one this route
 * declares. Distinct from 401 (which says nothing about the credential's
 * validity) and never a 200 with an empty body: a silent empty result would
 * make a permission problem look like missing data.
 */
export class InsufficientScopeError extends ApiV1Error {
  constructor(requiredScope: string) {
    super(
      'INSUFFICIENT_SCOPE',
      403,
      `This token lacks the '${requiredScope}' scope required for this operation.`,
    );
    this.name = 'InsufficientScopeError';
  }
}

/**
 * 422 — a malformed request the caller can fix: an invalid cursor, an
 * out-of-range or non-numeric `limit`, a failed body validation.
 */
export class InvalidRequestError extends ApiV1Error {
  constructor(code: string, message: string) {
    super(code, 422, message);
    this.name = 'InvalidRequestError';
  }
}

/**
 * The DOMAIN error code → v1 status map. A typed service error carries a
 * stable `code` (the `readonly code` convention every `lib/<domain>/errors.ts`
 * follows); this is where v1 decides what that means over HTTP.
 *
 * Recognition is by CODE, not by class, so the wrapper does not import every
 * domain's error module — and, critically, an UNLISTED code is NOT rendered:
 * it falls through to a bare 500. A new endpoint that can raise a new domain
 * error adds its row here deliberately, which is the point — an error reaching
 * a client is part of the public contract and should never appear by accident.
 *
 * Seeded with exactly what Story 11.1's endpoints can raise. Stories 11.2 /
 * 11.3 extend it as their resources land.
 */
export const DOMAIN_ERROR_STATUS: Readonly<Record<string, number>> = Object.freeze({
  // A token bound to workspace A asking about workspace B. 404, never 403 —
  // a 403 would confirm the resource EXISTS, an existence oracle over another
  // tenant's data. 403 answers "your token may not do this KIND of thing";
  // 404 answers "there is no such resource *for you*". (ADR §4.)
  NOT_A_MEMBER: 404,

  // ── Story 11.2, the work-item resource ────────────────────────────────────
  // Each row is added deliberately and each is exercised by a test that drives
  // the REAL error through the wrapper — an unproven row is indistinguishable
  // from a missing one, and a missing one is a silent 500.

  // 11.2.2 (MOTIR-2040) — the single-item read.
  WORK_ITEM_NOT_FOUND: 404,
  PROJECT_NOT_FOUND: 404,
  // ⚠️ 404, NOT 403. A 403 on a project the caller cannot browse confirms that
  // the project EXISTS — the same existence-oracle argument ADR §4 makes for
  // cross-tenant access, applied WITHIN a tenant. A caller who may not browse a
  // project must not be able to enumerate which project keys are real.
  PROJECT_ACCESS_DENIED: 404,

  // 11.2.6 (MOTIR-2046) — the write pair. Every one is a request the caller can
  // fix, proven by a test that drives the REAL service error through the wrapper.
  ILLEGAL_PARENT_TYPE: 422,
  CROSS_PROJECT_PARENT: 422,
  PARENT_CYCLE: 422,
  DEPTH_LIMIT_EXCEEDED: 422,
  TYPE_NOT_ALLOWED_ON_KIND: 422,
  ASSIGNEE_NOT_IN_WORKSPACE: 422,
  REPORTER_NOT_IN_WORKSPACE: 422,
  UNKNOWN_TARGET_REPO: 422,
  ARCHIVED_TARGET_REPO: 422,
  INVALID_ESTIMATE: 422,
  // ⚠️ 412, a status ADR §4's table does not yet list. A new CONDITION getting a
  // status is additive under §8 (unlike an existing condition changing one), so
  // the row is appended to the ADR rather than emitted undocumented.
  STALE_WORK_ITEM: 412,

  // 11.2.7 (MOTIR-2048) — the transitions sub-resource. Two DISTINCT codes:
  // collapsing them would make a typo (a status the workflow does not define)
  // and a workflow rule (a real status not reachable from here) indistinguishable,
  // and a client can fix only one of those.
  ILLEGAL_TRANSITION: 422,
  UNKNOWN_STATUS: 422,

  // 11.2.9 (MOTIR-2051) — the link edges.
  SELF_LINK: 422,
  WORK_ITEM_LINK_CYCLE: 422,
  // ⚠️ 409, a status ADR §4's table does not list either — appended with its
  // condition, as a NEW condition rather than a changed one. A duplicate link is
  // a conflict with existing STATE, not a malformed request: the caller's body
  // is perfectly valid, the edge simply already exists.
  DUPLICATE_LINK: 409,
  // 404 on the TARGET key, not 403: confirming that the other item exists in
  // another tenant is precisely the existence oracle ADR §4 forbids.
  CROSS_WORKSPACE_LINK: 404,
  WORKSPACE_MISMATCH_LINK: 404,
  WORK_ITEM_LINK_NOT_FOUND: 404,

  // 11.2.8 (MOTIR-2049) — comments.
  COMMENT_NOT_FOUND: 404,
  EMPTY_COMMENT_BODY: 422,
  INVALID_PARENT_COMMENT: 422,
  REPLY_DEPTH_EXCEEDED: 422,
  // ⚠️ 403, NOT 404 — the one place in this story the existence-oracle rule does
  // NOT apply. The item's own visibility is settled BEFORE the comment gate
  // runs, so the caller can already see the item; this is a genuine "you may not
  // do this KIND of thing" refusal, which is exactly what ADR §4 says 403 means.
  COMMENT_FORBIDDEN: 403,

  // 11.2.4 (MOTIR-2042) — the FilterAST the collection endpoint accepts. Every
  // one is a malformed REQUEST the caller can fix, so every one is a 422 with a
  // code specific enough to act on: which field, which operator, which value.
  UNKNOWN_FILTER_FIELD: 422,
  UNKNOWN_FILTER_OPERATOR: 422,
  INVALID_FILTER_VALUE: 422,
  FILTER_TOO_LARGE: 422,
  MALFORMED_FILTER: 422,

  // ── Story 11.3, the planning resources ────────────────────────────────────
  // Same discipline as 11.2's rows: each is added by the card whose endpoint can
  // raise it, and each is exercised by a test that drives the REAL error through
  // the wrapper. An unlisted code is a bare 500, which is exactly why a row is
  // never added speculatively.

  // 11.3.4 (MOTIR-2061) — the sprint reads. 404, not 403: `getById` is
  // workspace-gated, so a sprint in another tenant and one that never existed
  // are the same answer (ADR §4's existence-oracle rule).
  SPRINT_NOT_FOUND: 404,

  // 11.3.5 (MOTIR-2062) — the sprint write pair.
  //
  // ⚠️ 403, and DELIBERATELY a different `code` from `INSUFFICIENT_SCOPE`. Every
  // sprint write calls `assertSprintAdmin`, so a token that DOES carry
  // `sprints:write` is still refused when its OWNER is an ordinary project
  // member — a scope narrows the owner's role and never widens it (ADR §3).
  // "My token has the scope and I still get 403" is the single most confusing
  // thing this endpoint can do to an integrator, and a shared code would leave
  // them re-issuing tokens forever against a problem no token can fix.
  NOT_SPRINT_ADMIN: 403,
  INVALID_SPRINT_NAME: 422,
  SPRINT_WINDOW_INVALID: 422,
  // A conflict with existing STATE, not a malformed request: the body is fine,
  // the sprint is simply frozen.
  CANNOT_MODIFY_COMPLETED_SPRINT: 409,

  // 11.3.6 (MOTIR-2063) — the lifecycle moves, the only read-derived writes in
  // this story.
  //
  // ⚠️ 409, not 422. Losing the race to activate is a conflict with STATE the
  // caller could not have known about: the request was valid when it was sent and
  // another one committed first. A 422 would tell a client to fix its body, which
  // is exactly the wrong instruction — the right one is to re-read and retry.
  // This is what the shipped `FOR UPDATE` guard turns a lost race INTO, so a
  // concurrent start can never surface as a raw unique-violation 500.
  SPRINT_ALREADY_ACTIVE: 409,
  // 422: the sprint is in the wrong STATE for the move and the caller can see
  // that from a read — starting a non-planned sprint, completing a non-active one.
  SPRINT_NOT_STARTABLE: 422,
  SPRINT_NOT_COMPLETABLE: 422,
  INVALID_CARRY_OVER_TARGET: 422,
});

/** The 500 body: no `code`, no stack, no driver text. */
export const INTERNAL_ERROR_BODY: Readonly<{ error: string }> = Object.freeze({
  error: 'Internal server error.',
});

/** Anything carrying a string `code` — the shape every typed domain error has. */
function hasStringCode(err: unknown): err is { code: string; message: string } {
  return (
    typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string'
  );
}

/**
 * Classify a thrown value into the v1 envelope.
 *
 * Returns `undefined` for anything unrecognised — a raw `Error`, a Prisma
 * fault, a domain error whose code is not in {@link DOMAIN_ERROR_STATUS} — so
 * the caller renders {@link INTERNAL_ERROR_BODY} at 500 rather than leaking a
 * message that was never meant to be a public contract.
 */
export function classifyApiV1Error(
  err: unknown,
): { status: number; body: ApiV1ErrorBody } | undefined {
  if (err instanceof ApiV1Error) {
    return { status: err.status, body: { code: err.code, error: err.message } };
  }
  if (hasStringCode(err)) {
    const status = DOMAIN_ERROR_STATUS[err.code];
    if (status !== undefined) {
      return { status, body: { code: err.code, error: err.message } };
    }
  }
  return undefined;
}
