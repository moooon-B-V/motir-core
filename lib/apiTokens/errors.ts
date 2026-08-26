// Typed errors for the api-token domain (Story 7.8 · Subtask 7.8.1).
// Prisma-free (the lib/users / lib/savedFilters pattern) so routes, server
// actions, and the 7.8.4 MCP bearer gate can import them without pulling in
// the Prisma client. Each carries a stable `code` the consumers map:
//
//   ApiTokenNotFoundError → 404 — a token id that is missing OR owned by
//                           another user (the 404-not-403 contract: revoking
//                           someone else's token must not confirm it exists).
//   InvalidApiTokenError  → 401 (MCP gate) — the presented secret matches no
//                           live token (unknown / malformed / wrong hash).
//   ApiTokenRevokedError  → 401 — the token resolved but was soft-revoked.
//   ApiTokenExpiredError  → 401 — the token resolved but is past `expiresAt`.
//   InvalidApiTokenLabelError → 422 — blank / over-cap label at create.
//   InvalidTokenGrantError → 422 — a permission at create that is unknown or
//                           not grantable (MOTIR-2572).
//
// The three verify-failure errors are kept DISTINCT (not collapsed to one)
// so the 7.8.4 gate can surface the precise reason to the agent — "revoked"
// and "expired" are actionable ("mint a new token"), "invalid" is not.

export class InvalidApiTokenLabelError extends Error {
  readonly code = 'API_TOKEN_INVALID_LABEL' as const;
  constructor(message = 'A token label is required and must be at most 100 characters.') {
    super(message);
    this.name = 'InvalidApiTokenLabelError';
  }
}

/**
 * A create request whose SHAPE is illegal (MOTIR-2606; ADR Amendment 1 §A.5).
 *
 * There are exactly two legal calls, and the rule they encode is *the binding is
 * required where the grant is CHOSEN*:
 *
 *   * `{ permissions, projectId }` — a chosen grant, bound to a project.
 *   * `{ }` — the device path: `CLI_TOKEN_GRANT` and no project.
 *
 * A chosen grant with no project is refused because "may this token edit work
 * items?" has no answer until a project is named — permissions resolve per
 * project. A fixed grant WITH a project is refused because the device flow must
 * not quietly acquire a binding it never asked for.
 *
 * Four combinations of which two are bugs is a shape worth designing out rather
 * than testing around, so this error exists to make the other two unreachable.
 */
export class InvalidTokenBindingError extends Error {
  readonly code = 'API_TOKEN_INVALID_BINDING' as const;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTokenBindingError';
  }
}

/**
 * A create request named a permission that is not in the catalog, or is in the
 * catalog but is not GRANTABLE — no token-reachable operation asserts it
 * (`GRANTABLE_PERMISSIONS`, `lib/tokens/grant.ts`).
 *
 * The two cases share one error on purpose: from the caller's side they are the
 * same mistake — asking for authority a token cannot hold — and splitting them
 * would tell an unauthenticated-ish caller which catalog keys exist.
 *
 * ⚠️ It REFUSES rather than dropping. A create that silently discarded the keys
 * it did not recognise would mint a token whose grant is quietly narrower than
 * the one the user ticked, and they would find out at a 403 much later.
 */
export class InvalidTokenGrantError extends Error {
  readonly code = 'API_TOKEN_INVALID_PERMISSION' as const;
  /** The permission strings that were rejected. */
  readonly invalidPermissions: string[];
  constructor(invalidPermissions: string[]) {
    super(`Not a grantable permission: ${invalidPermissions.join(', ')}.`);
    this.name = 'InvalidTokenGrantError';
    this.invalidPermissions = invalidPermissions;
  }
}

export class ApiTokenNotFoundError extends Error {
  readonly code = 'API_TOKEN_NOT_FOUND' as const;
  constructor(tokenId: string) {
    super(`API token ${tokenId} was not found.`);
    this.name = 'ApiTokenNotFoundError';
  }
}

export class InvalidApiTokenError extends Error {
  readonly code = 'API_TOKEN_INVALID' as const;
  constructor() {
    super('The API token is invalid.');
    this.name = 'InvalidApiTokenError';
  }
}

/**
 * A presented token whose row still carries `revoked_at`.
 *
 * ⚠️ RETAINED AS A TRANSITION GUARD ONLY (MOTIR-3546). Revoking now DELETES the
 * row, so nothing writes this column any more and the migration cleared every
 * row that had it. It survives because `fly.toml` runs migrations BEFORE the
 * new image takes traffic: during a rolling release the OLD image is still
 * stamping `revoked_at`, and without this arm such a token would come back
 * VALID once the rollout finished. It is deleted together with the column.
 *
 * Never distinguished on the wire: `/api/v1` and the MCP gate collapse all five
 * 401 causes into one undifferentiated `unauthenticated`
 * (`docs/decisions/public-api-conventions.md` §"Distinguishing 401 causes").
 */
export class ApiTokenRevokedError extends Error {
  readonly code = 'API_TOKEN_REVOKED' as const;
  constructor() {
    super('The API token has been revoked.');
    this.name = 'ApiTokenRevokedError';
  }
}

export class ApiTokenExpiredError extends Error {
  readonly code = 'API_TOKEN_EXPIRED' as const;
  constructor() {
    super('The API token has expired.');
    this.name = 'ApiTokenExpiredError';
  }
}
