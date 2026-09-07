// The `?gitlab=<status>` values the git settings surface renders as a banner
// (Story 7.23 · MOTIR-1478, moved to the ORG tier by MOTIR-4669 · MOTIR-4680).
//
// ⚠️ IT IS A SEPARATE MAP FROM GITHUB'S, AND THAT IS THE POINT. The two flows
// have different terminal outcomes — GitLab has no App to install, so none of
// the `install_*` statuses exist, and it has `no_workspace`, which GitHub's
// start route cannot reach. Folding them into one union would make every
// consumer of either handle statuses that provider can never emit, and would
// hide the one status each of them actually needs.
//
// It lives here, beside GitHub's, for the same reason that one does: three
// things must agree on the set and none of them owns it — the routes that emit a
// status, the tone map, and the `gitlab.banner.*` copy in every locale.

export const GITLAB_BANNER_STATUSES = [
  'connected',
  'denied',
  'state_error',
  'error',
  'not_configured',
  'no_workspace',
] as const;

export type GitlabBannerStatus = (typeof GITLAB_BANNER_STATUSES)[number];

export type GitlabBannerTone = 'success' | 'danger' | 'info';

/**
 * The tone each outcome renders in. TOTAL by construction.
 *
 * ⚠️ The tone is part of what the banner SAYS: a red banner is itself the claim
 * that something failed. `not_configured` and `no_workspace` are states of the
 * DEPLOYMENT or the session, not failures of the round trip the reader just
 * took, so both are `info` — the same rule MOTIR-3755 applied to GitHub's.
 */
export const GITLAB_BANNER_TONE: Record<GitlabBannerStatus, GitlabBannerTone> = {
  connected: 'success',
  denied: 'danger',
  state_error: 'danger',
  error: 'danger',
  not_configured: 'info',
  no_workspace: 'info',
};
