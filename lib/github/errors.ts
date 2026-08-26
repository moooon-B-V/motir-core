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

/**
 * The inbound-webhook shared secret (`GITHUB_WEBHOOK_SECRET`) is not configured
 * on this deployment (Story 7.10 · MOTIR-892). Read at call time, so a
 * self-hosted instance that never wires GitHub can't reach the webhook path
 * rather than crashing on boot. A server MISCONFIG (→ 500), distinct from a bad
 * signature (→ 401): without a secret we can neither trust nor reject a delivery.
 */
export class GithubWebhookNotConfiguredError extends Error {
  readonly code = 'GITHUB_WEBHOOK_NOT_CONFIGURED' as const;
  constructor() {
    super('GitHub webhooks are not configured. Set GITHUB_WEBHOOK_SECRET.');
    this.name = 'GithubWebhookNotConfiguredError';
  }
}

/**
 * A webhook delivery's `X-Hub-Signature-256` is missing or does not match the
 * HMAC we recompute over the raw body with `GITHUB_WEBHOOK_SECRET` (Story 7.10 ·
 * MOTIR-892). The route rejects it 401 BEFORE parsing the body — an unauthentic
 * delivery is never processed. Carries no detail (nothing to leak to an attacker
 * probing the endpoint).
 */
export class GithubWebhookSignatureError extends Error {
  readonly code = 'GITHUB_WEBHOOK_INVALID_SIGNATURE' as const;
  constructor() {
    super('GitHub webhook signature verification failed.');
    this.name = 'GithubWebhookSignatureError';
  }
}

/**
 * The workspace has no GitHub App installation (Story 7.10 · MOTIR-1596). The
 * explicit item→PR link picker can offer no candidates — design/github Panel 5c's
 * disconnected-workspace banner. The two grants are independent, so this means
 * the installation grant is absent, regardless of the per-user identity grant.
 */
export class GithubNotConnectedError extends Error {
  readonly code = 'GITHUB_NOT_CONNECTED' as const;
  constructor() {
    super('GitHub is not connected for this workspace.');
    this.name = 'GithubNotConnectedError';
  }
}

/**
 * The target PR does not exist in the caller's workspace (Story 7.10 ·
 * MOTIR-1596): an unknown id OR a cross-workspace probe — collapsed to ONE error
 * so existence never leaks (the no-leak convention). Surfaced in the explicit-
 * link form's rose banner.
 */
export class GithubPullRequestNotFoundError extends Error {
  readonly code = 'GITHUB_PR_NOT_FOUND' as const;
  constructor(id: string) {
    super(`GitHub pull request not found: ${id}`);
    this.name = 'GithubPullRequestNotFoundError';
  }
}

/**
 * The named REPOSITORY does not exist in the caller's workspace (Story
 * MOTIR-3525 · MOTIR-3526): an unknown `owner/name` OR a cross-workspace probe —
 * collapsed to ONE error so existence never leaks, exactly as
 * {@link GithubPullRequestNotFoundError} does for a pull request.
 *
 * Raised by the coordinate-addressed link path, which resolves the repository
 * from the REPO ROW's own `workspace_id` (MOTIR-1931) rather than through its
 * installation — under Motir's shared provisioning installation the
 * installation names no workspace at all, so the older join would have made
 * this permanently not-found for every repository Motir created.
 */
export class GithubRepoNotFoundError extends Error {
  readonly code = 'GITHUB_REPO_NOT_FOUND' as const;
  constructor(coordinate: string) {
    super(
      `GitHub repository not connected in this workspace: ${coordinate}. ` +
        'Name it as "owner/name" exactly as the repository is connected.',
    );
    this.name = 'GithubRepoNotFoundError';
  }
}
