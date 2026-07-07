// Typed errors for the Jira OAuth 2.0 (3LO) connect flow (Story 7.16 ·
// MOTIR-1654). Kept in their own file so the route handlers can import them
// without pulling in the Prisma client or the service (mirrors
// lib/github/errors.ts). Each carries a discriminating `code` the route layer
// maps to a redirect-status query the import wizard renders as a banner.

/**
 * The Jira OAuth app credentials (`JIRA_OAUTH_CLIENT_ID` /
 * `JIRA_OAUTH_CLIENT_SECRET`, registered in MOTIR-943) are not configured on
 * this deployment. Read at call time (not module load), so a self-hosted
 * instance that never wires Jira import simply can't reach the flow rather than
 * crashing on boot — the routes surface this as a redirect.
 */
export class JiraOAuthNotConfiguredError extends Error {
  readonly code = 'JIRA_OAUTH_NOT_CONFIGURED' as const;
  constructor() {
    super('Jira OAuth is not configured. Set JIRA_OAUTH_CLIENT_ID and JIRA_OAUTH_CLIENT_SECRET.');
    this.name = 'JiraOAuthNotConfiguredError';
  }
}

/**
 * The 3LO grant failed at Atlassian: the code→token exchange returned no token,
 * the token refresh failed, or `accessible-resources` resolved no Jira site.
 * Never carries Atlassian's raw error body (which can echo the code / token) —
 * just a stable code the callback turns into a redirect the wizard renders as
 * "couldn't connect, try again".
 */
export class JiraOAuthExchangeError extends Error {
  readonly code = 'JIRA_OAUTH_EXCHANGE_FAILED' as const;
  constructor(detail: string) {
    super(`Jira OAuth 3LO grant failed: ${detail}`);
    this.name = 'JiraOAuthExchangeError';
  }
}
