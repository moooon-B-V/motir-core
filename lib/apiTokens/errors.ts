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
//   InvalidApiTokenScopeError → 422 — an unrecognized scope string at create
//                           (Story 7.7 · Subtask 7.7.16).
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

export class InvalidApiTokenScopeError extends Error {
  readonly code = 'API_TOKEN_INVALID_SCOPE' as const;
  /** The unknown scope strings that were rejected. */
  readonly invalidScopes: string[];
  constructor(invalidScopes: string[]) {
    super(`Unknown API token scope(s): ${invalidScopes.join(', ')}.`);
    this.name = 'InvalidApiTokenScopeError';
    this.invalidScopes = invalidScopes;
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
