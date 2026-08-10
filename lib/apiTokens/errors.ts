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
