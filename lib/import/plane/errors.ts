// Typed errors for the Plane "Connect" OAuth flow (Story 7.16 · MOTIR-1656).
// Kept in their own file so the route handlers can import them without pulling
// in the Prisma client or the service (mirrors lib/import/jira/errors.ts). Each
// carries a discriminating `code` the route layer maps to a redirect-status
// query the import wizard renders as a banner.

/**
 * The Plane OAuth app credentials for the target instance are not configured on
 * this deployment. For Plane Cloud that is `PLANE_OAUTH_CLIENT_ID` /
 * `PLANE_OAUTH_CLIENT_SECRET` (registered in MOTIR-1659); for a self-hosted
 * instance it is the per-host entry in `PLANE_OAUTH_INSTANCES`. Read at call
 * time (not module load), so a deployment that never wires Plane import simply
 * can't reach the flow rather than crashing on boot — the routes surface this
 * as a redirect.
 */
export class PlaneOAuthNotConfiguredError extends Error {
  readonly code = 'PLANE_OAUTH_NOT_CONFIGURED' as const;
  constructor(detail?: string) {
    super(
      detail ??
        'Plane OAuth is not configured. Set PLANE_OAUTH_CLIENT_ID and PLANE_OAUTH_CLIENT_SECRET (Cloud) or a PLANE_OAUTH_INSTANCES entry (self-hosted).',
    );
    this.name = 'PlaneOAuthNotConfiguredError';
  }
}

/**
 * The connect grant failed at Plane: the code→token exchange was unreachable,
 * returned a non-2xx / non-JSON body, carried no `access_token`, or the token
 * refresh failed. Never carries Plane's raw error body (which can echo the code
 * / token) — just a stable code the callback turns into a redirect the wizard
 * renders as "couldn't connect, try again".
 */
export class PlaneOAuthExchangeError extends Error {
  readonly code = 'PLANE_OAUTH_EXCHANGE_FAILED' as const;
  constructor(detail: string) {
    super(`Plane OAuth connect failed: ${detail}`);
    this.name = 'PlaneOAuthExchangeError';
  }
}

/**
 * The instance base URL the member supplied is not a usable absolute `http(s)`
 * URL. Caught at the route boundary and surfaced as a redirect so a typo'd
 * self-hosted URL doesn't reach the OAuth host resolution (or an SSRF-shaped
 * value the token exchange would POST the client secret to).
 */
export class PlaneInvalidBaseUrlError extends Error {
  readonly code = 'PLANE_INVALID_BASE_URL' as const;
  constructor() {
    super('The Plane instance URL must be an absolute http(s) URL.');
    this.name = 'PlaneInvalidBaseUrlError';
  }
}
