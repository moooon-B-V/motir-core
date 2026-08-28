// The `?github=<status>` values the GitHub settings surface renders as a banner
// (Story 7.10 — MOTIR-1498 the OAuth identity grant, MOTIR-1588 the App install;
// MOTIR-3755 split the install outcomes apart).
//
// It lives here rather than in either route because THREE things have to agree
// on the set and none of them owns it: the routes that emit a status, the page's
// tone map, and the `github.banner.*` copy in every locale. Declaring it once
// makes both halves total — a status with no tone is a type error, and one with
// no copy fails `tests/github/setupRoute.test.ts`.

export const GITHUB_BANNER_STATUSES = [
  // The identity grant — `app/api/github/oauth/{start,callback}/route.ts`.
  'connected',
  'denied',
  'state_error',
  'error',
  'not_configured',
  // The App install / setup round trip — `app/api/github/setup/route.ts`.
  'installed',
  'repos_updated',
  'install_unbound',
  'install_expired',
  'install_forbidden',
  'install_provider_error',
  'install_error',
] as const;

export type GithubBannerStatus = (typeof GITHUB_BANNER_STATUSES)[number];

export type GithubBannerTone = 'success' | 'danger' | 'info';

// The tone each outcome renders in. TOTAL by construction — a new status with no
// tone is a type error.
//
// ⚠️ The tone is part of what the banner SAYS (MOTIR-3755): a red banner is
// itself the claim that setup failed, whatever the copy underneath it reads. So
// every outcome in which NOTHING WENT WRONG — the repository selection changed,
// the install link timed out — is barred from `danger`, and
// `tests/github/setupRoute.test.ts` asserts that rather than leaving it to
// whoever adds the next status.
export const GITHUB_BANNER_TONE: Record<GithubBannerStatus, GithubBannerTone> = {
  connected: 'success',
  installed: 'success',
  repos_updated: 'success',
  denied: 'danger',
  state_error: 'danger',
  error: 'danger',
  install_error: 'danger',
  install_forbidden: 'danger',
  install_provider_error: 'danger',
  install_expired: 'info',
  install_unbound: 'info',
  not_configured: 'info',
};

/** The outcomes in which the operation SUCCEEDED or simply needs restarting —
 *  nothing is broken and nothing failed. None of them may render as `danger`. */
export const GITHUB_BENIGN_BANNER_STATUSES = [
  'connected',
  'installed',
  'repos_updated',
  'install_expired',
  'install_unbound',
  'not_configured',
] as const satisfies readonly GithubBannerStatus[];
