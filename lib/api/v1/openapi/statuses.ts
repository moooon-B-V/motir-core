// The v1 STATUS VOCABULARY (Story 11.4 · Subtask 11.4.3 — MOTIR-2184).
//
// Every HTTP status a `/api/v1` response can carry, declared as a VALUE so the
// emitted OpenAPI document can enumerate it — and so a status the code can
// return but the document has no word for becomes a failure rather than a
// documentation gap.
//
// ── Why this is a compile-time guarantee, not a comment ─────────────────────
// `DOMAIN_ERROR_STATUS` (`lib/api/v1/errors.ts`) is typed
// `Readonly<Record<string, V1ErrorStatus>>` against the union below, so a row
// added with an undocumented status is a TYPE error at the map itself — the
// same shape `TOOL_SCOPES: Record<McpToolName, TokenScope>` uses to make an
// ungated MCP tool a compile error. `tests/api/v1/openapi-shared-schemas.test.ts`
// re-asserts the totality at runtime so the guarantee survives type erasure, and
// proves the check FAILS on a map carrying an unlisted status.
//
// ⚠️ Adding a status here is not free: it is a claim about the contract. ADR §8
// permits a NEW condition getting a status (409 and 412 arrived that way, from
// Subtasks 11.2.9 and 11.2.6) and forbids an EXISTING condition changing one.
// This list is the §4 table, in code.

/** Statuses a SUCCESSFUL v1 response can carry. */
export const V1_SUCCESS_STATUSES = [200, 201, 202, 204] as const;

/** Statuses a FAILED v1 response can carry — the ADR §4 table. */
export const V1_ERROR_STATUSES = [401, 402, 403, 404, 409, 412, 422, 429, 500, 503] as const;

/** A success status, as a type. */
export type V1SuccessStatus = (typeof V1_SUCCESS_STATUSES)[number];

/**
 * An error status, as a type.
 *
 * This is the union `DOMAIN_ERROR_STATUS` is keyed against, which is what makes
 * "a domain error mapped to an undocumented status" unrepresentable rather than
 * merely untested.
 */
export type V1ErrorStatus = (typeof V1_ERROR_STATUSES)[number];

/** Any status a v1 response can carry. */
export type V1Status = V1SuccessStatus | V1ErrorStatus;

/** Every status, success and error alike, in ascending order. */
export const V1_STATUSES: readonly V1Status[] = [
  ...V1_SUCCESS_STATUSES,
  ...V1_ERROR_STATUSES,
] as const;

/**
 * What each status MEANS on this API — the description the emitted document
 * carries on every response object that uses it.
 *
 * Typed `Record<V1Status, string>`, so a status added to either list above
 * without a description fails typecheck. Each sentence is the CONDITION from
 * ADR §4's table, not a restatement of the RFC: "404" is worth documenting only
 * because v1's 404 deliberately also means "outside your workspace".
 */
export const V1_STATUS_DESCRIPTIONS: Record<V1Status, string> = {
  200: 'The request succeeded.',
  201: 'The resource was created.',
  202: 'The request was ACCEPTED and a background job was started. Nothing has been produced yet — the body carries a handle to poll, never a result.',
  204: 'The request succeeded and the response has no body.',
  401: 'Authentication required. No token, or a token that is malformed, unknown, revoked or expired — the five are deliberately undifferentiated.',
  402: 'The workspace owner’s AI credits are exhausted. The request was valid; it was refused for want of balance, and retrying will not help until credits are topped up.',
  403: 'The token is valid but its granted scopes do not include the one this operation requires.',
  404: 'The resource does not exist, or it is outside the workspace this token is bound to — deliberately the same answer.',
  409: 'The request conflicts with existing state. The body is well-formed; the state is not what the request assumed.',
  412: 'An `If-Match` precondition failed — the resource moved since the validator was issued.',
  422: 'The request is malformed in a way the caller can fix: an invalid cursor, an out-of-range `limit`, a failed body validation.',
  429: "The token's rate-limit budget for the current window is exhausted. Read `X-RateLimit-Reset` for when it refills.",
  500: 'An unexpected server fault. The body carries no `code`, no stack and no driver text.',
  503: 'A dependency this operation needs — the motir-ai planning service — could not be reached or is misconfigured. The request itself was fine; retrying later is the right response.',
};

/** Membership test usable on an untrusted number (a value read off a map). */
export function isV1Status(value: number): value is V1Status {
  return (V1_STATUSES as readonly number[]).includes(value);
}

/** Membership test for the ERROR half specifically. */
export function isV1ErrorStatus(value: number): value is V1ErrorStatus {
  return (V1_ERROR_STATUSES as readonly number[]).includes(value);
}

/**
 * Every status in `statusMap` that this vocabulary does not document.
 *
 * Exported rather than inlined in the test for the reason
 * `tests/helpers/v1RouteAudit.ts` gives about its own rules: a guard must be
 * runnable against BOTH the real map (does the product hold?) and a
 * deliberately-violating synthetic one (does the guard actually catch it?). A
 * check that has only ever been shown to pass is not a check.
 */
export function undocumentedStatuses(statusMap: Readonly<Record<string, number>>): number[] {
  const offenders = new Set<number>();
  for (const status of Object.values(statusMap)) {
    if (!isV1Status(status)) offenders.add(status);
  }
  return [...offenders].sort((a, b) => a - b);
}
