// Typed errors for the Linear import "Connect" flow (Story 7.16 · MOTIR-1655).
// Kept in their own file so the route handlers can import them without pulling
// in the Prisma client or the service. Each carries a discriminating `code` the
// route layer maps to an HTTP redirect status query. Mirrors lib/github/errors.

/**
 * The Linear OAuth app credentials (`LINEAR_OAUTH_CLIENT_ID` /
 * `LINEAR_OAUTH_CLIENT_SECRET`, registered in MOTIR-1658) are not configured on
 * this deployment. Read at call time (not module load), so a self-hosted
 * instance that never wires the Linear import simply can't reach the flow rather
 * than crashing on boot (the routes surface this as a redirect banner).
 */
export class LinearOAuthNotConfiguredError extends Error {
  readonly code = 'LINEAR_OAUTH_NOT_CONFIGURED' as const;
  constructor() {
    super(
      'Linear OAuth is not configured. Set LINEAR_OAUTH_CLIENT_ID and LINEAR_OAUTH_CLIENT_SECRET.',
    );
    this.name = 'LinearOAuthNotConfiguredError';
  }
}

/**
 * The Linear connect grant failed at Linear: the code→token exchange was
 * unreachable, returned a non-2xx / non-JSON body, or carried no `access_token`.
 * Never carries Linear's raw error body (which can echo the code) — just a
 * stable code the callback turns into a redirect the import wizard renders as
 * "couldn't connect, try again".
 */
export class LinearOAuthExchangeError extends Error {
  readonly code = 'LINEAR_OAUTH_EXCHANGE_FAILED' as const;
  constructor(detail: string) {
    super(`Linear OAuth connect failed: ${detail}`);
    this.name = 'LinearOAuthExchangeError';
  }
}
