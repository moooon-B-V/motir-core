// Typed errors for the GitLab integration (Story 7.23 · MOTIR-1474). Kept in
// their own file so route handlers can import them without pulling in the Prisma
// client or the service. Each carries a discriminating `code` the route layer
// maps to an HTTP redirect status query. Mirrors `lib/github/errors.ts`.

/**
 * The GitLab OAuth application credentials (`GITLAB_APP_CLIENT_ID` /
 * `GITLAB_APP_CLIENT_SECRET`) are not configured on this deployment. Read at
 * call time (not module load), so a self-hosted instance that never wires
 * GitLab simply can't reach the flow rather than crashing on boot.
 */
export class GitlabOAuthNotConfiguredError extends Error {
  readonly code = 'GITLAB_OAUTH_NOT_CONFIGURED' as const;
  constructor() {
    super('GitLab OAuth is not configured. Set GITLAB_APP_CLIENT_ID and GITLAB_APP_CLIENT_SECRET.');
    this.name = 'GitlabOAuthNotConfiguredError';
  }
}

/**
 * The connect grant failed at GitLab: the code→token exchange returned no token,
 * or the `GET /user` read failed. Never carries the raw GitLab error body (which
 * can echo the code) — just a stable code the callback turns into a redirect the
 * settings UI renders as "couldn't connect, try again".
 */
export class GitlabOAuthExchangeError extends Error {
  readonly code = 'GITLAB_OAUTH_EXCHANGE_FAILED' as const;
  constructor(detail: string) {
    super(`GitLab OAuth connect failed: ${detail}`);
    this.name = 'GitlabOAuthExchangeError';
  }
}

/**
 * Refreshing an expired GitLab access token failed — the stored refresh token
 * was rejected (revoked / already rotated) or the token endpoint erred. The
 * connection must be re-connected. Carries no raw GitLab body.
 */
export class GitlabTokenRefreshError extends Error {
  readonly code = 'GITLAB_TOKEN_REFRESH_FAILED' as const;
  constructor(detail: string) {
    super(`GitLab token refresh failed: ${detail}`);
    this.name = 'GitlabTokenRefreshError';
  }
}

/**
 * A stored GitLab connection was expected but not found for the given connection
 * id — e.g. the seam asked to mint a token for a connection that was disconnected
 * between resolve and mint. A stable code, never a leak of which ids exist.
 */
export class GitlabConnectionNotFoundError extends Error {
  readonly code = 'GITLAB_CONNECTION_NOT_FOUND' as const;
  constructor() {
    super('GitLab connection not found.');
    this.name = 'GitlabConnectionNotFoundError';
  }
}

/**
 * The inbound-webhook shared secret (`GITLAB_WEBHOOK_SECRET`) is not configured on
 * this deployment (Story 7.23 · MOTIR-1475). Read at call time, so a self-hosted
 * instance that never wires GitLab can't reach the webhook path rather than
 * crashing on boot. A server MISCONFIG (→ 500), distinct from a bad token (→ 401):
 * without a secret we can neither trust nor reject a delivery. Mirrors
 * `GithubWebhookNotConfiguredError`.
 */
export class GitlabWebhookNotConfiguredError extends Error {
  readonly code = 'GITLAB_WEBHOOK_NOT_CONFIGURED' as const;
  constructor() {
    super('GitLab webhooks are not configured. Set GITLAB_WEBHOOK_SECRET.');
    this.name = 'GitlabWebhookNotConfiguredError';
  }
}

/**
 * A webhook delivery's `X-Gitlab-Token` is missing or does not match the
 * configured `GITLAB_WEBHOOK_SECRET` (Story 7.23 · MOTIR-1475). GitLab signs a
 * project webhook with a per-hook SECRET TOKEN it echoes verbatim in this header
 * (there is no body HMAC, unlike GitHub), so verification is a constant-time
 * compare of the header against the shared secret. The route rejects a mismatch
 * 401 BEFORE parsing the body — an unauthentic delivery is never processed.
 * Carries no detail (nothing to leak to an attacker probing the endpoint).
 */
export class GitlabWebhookSignatureError extends Error {
  readonly code = 'GITLAB_WEBHOOK_INVALID_SIGNATURE' as const;
  constructor() {
    super('GitLab webhook token verification failed.');
    this.name = 'GitlabWebhookSignatureError';
  }
}
