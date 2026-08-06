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

import type { V1ErrorStatus } from '@/lib/api/v1/openapi/statuses';

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
 *
 * ⚠️ The VALUE type is `V1ErrorStatus` (Story 11.4 · Subtask 11.4.3), not
 * `number`: the statuses this API documents are a closed vocabulary
 * (`lib/api/v1/openapi/statuses.ts`, ADR §4's table in code), so a row mapped to
 * a status the emitted OpenAPI document has no word for is a COMPILE error here
 * rather than an undocumented response discovered by a client. Adding a status
 * is a contract change — ADR §8 permits a new CONDITION getting one (409 and 412
 * arrived that way) and forbids an existing condition changing one — so it is
 * made in the vocabulary, deliberately, and this map then compiles against it.
 */
export const DOMAIN_ERROR_STATUS: Readonly<Record<string, V1ErrorStatus>> = Object.freeze({
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

  // 11.3.7 (MOTIR-2064) — the membership moves.
  //
  // 422: the batch is too large for one atomic move. The service's message names
  // the cap, so a caller can split the batch rather than guess at it. NOT
  // silently truncated — a partial move is exactly what the atomicity of these
  // endpoints exists to prevent.
  BULK_BATCH_TOO_LARGE: 422,
  // 422: the item and the sprint belong to different projects. A request the
  // caller can fix, and one that rejects the WHOLE batch before any write.
  CROSS_PROJECT_SPRINT_ASSIGNMENT: 422,

  // ── Story 11.7, the work-loop operations ──────────────────────────────────
  // Same discipline again: added by the card whose endpoint can raise it, each
  // driven through the wrapper by a test.

  // 11.7.5 (MOTIR-2239) — expansion and the plan reads.
  //
  // 404, not 403: `plansService.getPlan` is workspace-scoped and then applies
  // `assertCanBrowse`, so a plan in another tenant and one that never existed
  // are the same answer (§4's existence-oracle rule).
  PLAN_NOT_FOUND: 404,
  // 422, and it means exactly ONE thing here: the target is a LEAF, which
  // cannot be expanded. The service raises this same error for a key naming no
  // item too — which would be a 404, not a 422 — so the route reads the item
  // FIRST and lets that read raise its own `WORK_ITEM_NOT_FOUND`. A status map
  // cannot split one error class after the fact; the route has to not conflate
  // them in the first place.
  INVALID_TARGET: 422,
  // ⚠️ 402, a status ADR §4's table did not list. A NEW condition getting a
  // status, which §8 permits (409 and 412 arrived the same way). The request was
  // valid and was refused for want of BALANCE — 422 would tell a client to fix
  // its body, 429 would tell it to wait for a window that never refills, and
  // both are the wrong instruction. The right one is "top up".
  MOTIR_AI_OUT_OF_CREDITS: 402,
  CI_CREDITS_EXHAUSTED: 402,
  // ⚠️ 503, also new, also a new condition. An upstream dependency being down or
  // misconfigured is not an UNEXPECTED fault, so §4's bare 500 ("no code, no
  // stack") would tell a client nothing it could act on. 503 says "the request
  // was fine, come back" — the one answer that makes a retry loop correct rather
  // than a way to hammer an outage.
  MOTIR_AI_UNAVAILABLE: 503,
  MOTIR_AI_CONFIG: 503,
  MOTIR_AI_UNAUTHORIZED: 503,

  // 11.7.6 (MOTIR-2240) — the planning conversation.
  //
  // 404: the thread does not exist for this scope. Same existence-oracle rule —
  // a scope in another tenant never reaches the service, because the project
  // read answers 404 first.
  PLAN_CHANGE_SESSION_NOT_FOUND: 404,
  // ⚠️ 409, not 422. Two writers appended to one thread and lost the race for a
  // `seq`; the body was perfectly valid when it was sent. 422 would tell the
  // caller to fix its body, which is the wrong instruction — the right one is to
  // re-read and retry.
  PLAN_CHANGE_TURN_CONFLICT: 409,
  // 422: a submit on a thread with nothing on it. The caller can fix that by
  // appending a turn, and it must NOT be a 500 — an empty thread is an ordinary
  // state, not a fault.
  PLAN_CHANGE_EMPTY_INTENT: 422,
  // 422: an empty turn body.
  PLAN_CHANGE_EMPTY_TURN: 422,
  // 422: the anchor set exceeds `MAX_SCOPE_TARGETS`. Refused BEFORE the
  // resolution fan-out, because the cost of a huge set is that fan-out.
  PLAN_CHANGE_TOO_MANY_TARGETS: 422,

  // 11.7.7 (MOTIR-2241) — the activity read. Its own failure modes are the
  // wrapper's (401/403/429), the shared cursor 422, and `WORK_ITEM_NOT_FOUND`
  // above; the view and order parameters raise `InvalidRequestError` directly,
  // which is already a v1 error rather than a domain one.

  // ⚠️ DELIBERATELY ABSENT, and this comment is the deliberation:
  //   • `MOTIR_AI_BAD_REQUEST` — motir-ai rejected a payload MOTIR-CORE built.
  //     That is our bug, not the caller's, and §4's bare 500 is exactly the
  //     right answer: no `code` to branch on, because there is no stable
  //     contract for one of our own faults. A row here would leak an internal
  //     message as a public code.
  //   • `MOTIR_AI_JOB_NOT_FOUND` / `MOTIR_AI_JOB_FAILED` — neither escapes these
  //     endpoints. `resolveJobState` catches every `MotirAiError` and reports it
  //     as `job.reachable: false` / `job.failure`, because the PLAN read already
  //     succeeded and degrading the job block beats failing an answer we have.
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
