// Typed errors for the GitHub integration (Story 7.10 · MOTIR-1498). Kept in
// their own file so route handlers can import them without pulling in the
// Prisma client or the service. Each carries a discriminating `code` the route
// layer maps to an HTTP redirect status query.

/**
 * The GitHub OAuth app credentials (`GITHUB_APP_CLIENT_ID` /
 * `GITHUB_APP_CLIENT_SECRET`) are not configured on this deployment. Read at
 * call time (not module load), so a self-hosted instance that never wires
 * GitHub simply can't reach the flow rather than crashing on boot.
 */
export class GithubOAuthNotConfiguredError extends Error {
  readonly code = 'GITHUB_OAUTH_NOT_CONFIGURED' as const;
  constructor() {
    super('GitHub OAuth is not configured. Set GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET.');
    this.name = 'GithubOAuthNotConfiguredError';
  }
}

/**
 * The user-identity grant failed at GitHub: the code→token exchange returned
 * no token, or the `GET /user` read failed. Never carries the raw GitHub error
 * body (which can echo the code) — just a stable code the callback turns into a
 * redirect the settings UI renders as "couldn't connect, try again".
 */
export class GithubOAuthExchangeError extends Error {
  readonly code = 'GITHUB_OAUTH_EXCHANGE_FAILED' as const;
  constructor(detail: string) {
    super(`GitHub OAuth identity grant failed: ${detail}`);
    this.name = 'GithubOAuthExchangeError';
  }
}
