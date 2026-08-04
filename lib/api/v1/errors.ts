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
