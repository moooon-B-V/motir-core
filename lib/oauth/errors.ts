// Typed errors for OAuth connections (Story MOTIR-6973 · Subtask MOTIR-6983).
// Prisma-free, so the consent page, the Connected apps routes and the MCP gate
// can import them without the client. Each carries a stable `code`:
//
//   OAuthConsentRequestInvalidError → 400 — the consent request is not one Motir
//       issued (a missing or forged signature, an expired request, an unknown or
//       disabled client). Nothing is recorded. `reason` names which, so the
//       consent page can say it in words (design Panel 7).
//   OAuthConnectionNotFoundError → 404 — revoking a connection that is missing
//       OR another person's (404-not-403: no existence leak).
//   OAuthAccessTokenRejectedError → 401 at the MCP gate — the bearer resolves to
//       no connection it may act through. `reason` is for logs and tests; the
//       gate answers every reason with the same 401, as it does for a PAT.

/**
 * Why a consent request cannot be used — the consent page's refused state names
 * each in words (`design/auth/design-notes.md` § OAuth consent, Panel 7).
 */
export type OAuthConsentProblem =
  /** No client with this id, or a disabled one. */
  | 'invalid_client'
  /** The `redirect_uri` is not one the client registered. */
  | 'invalid_redirect'
  /** PKCE missing, or a method other than S256. */
  | 'code_challenge'
  /** `resource` is not Motir's MCP. */
  | 'invalid_target'
  /** A request Motir signed, too old to use. */
  | 'expired'
  /** A request Motir did not sign (no or a forged signature). */
  | 'not_issued'
  /** The provider refused to complete a request that passed Motir's checks. */
  | 'rejected';

export class OAuthConsentRequestInvalidError extends Error {
  readonly code = 'OAUTH_CONSENT_REQUEST_INVALID' as const;
  readonly reason: OAuthConsentProblem;
  constructor(detail: string, reason: OAuthConsentProblem = 'not_issued') {
    super(`This connection request can't be used: ${detail}.`);
    this.name = 'OAuthConsentRequestInvalidError';
    this.reason = reason;
  }
}

export class OAuthConnectionNotFoundError extends Error {
  readonly code = 'OAUTH_CONNECTION_NOT_FOUND' as const;
  constructor(connectionId: string) {
    super(`Connection ${connectionId} was not found.`);
    this.name = 'OAuthConnectionNotFoundError';
  }
}

/** Why an OAuth bearer was refused. */
export type OAuthAccessTokenRejection =
  /** No access token with this hash — never issued, revoked, or rotated away. */
  | 'unknown'
  /** Past its `expiresAt`; the client refreshes. */
  | 'expired'
  /**
   * Stamped `revoked` by the provider (better-auth 1.7, MOTIR-7171): it does so
   * to the access tokens of a browser session that signs out. The connection's
   * `offline_access` refresh token survives, so the client refreshes.
   */
  | 'revoked'
  /** Issued outside a Motir consent decision, so it carries no connection. */
  | 'unbound'
  /** The consenting person is no longer in the connection's workspace. */
  | 'left_workspace';

export class OAuthAccessTokenRejectedError extends Error {
  readonly code = 'OAUTH_ACCESS_TOKEN_REJECTED' as const;
  readonly reason: OAuthAccessTokenRejection;
  constructor(reason: OAuthAccessTokenRejection) {
    super(`The OAuth access token was refused (${reason}).`);
    this.name = 'OAuthAccessTokenRejectedError';
    this.reason = reason;
  }
}
