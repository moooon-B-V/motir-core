// The application's own absolute origin — and the ONE place its precedence
// lives (MOTIR-2388; `docs/decisions/application-hosting.md` §4 / Q3).
//
// Everything that builds an absolute URL pointing back AT this app resolves
// through here: emailed links (invite, mention, watcher, saved-filter digest,
// password reset), Better-Auth's `baseURL` and `trustedOrigins`, OAuth callback
// URLs, the public-project canonical / OpenGraph / sitemap origin, and the
// automation e-mail CTA. Nothing else may read the variable directly — a second
// reader is a second answer to the question this module exists to answer once.
//
// Precedence — TWO rungs, and deliberately only two:
//
//   1. MOTIR_BASE_URL — every deployed environment; set as a platform secret.
//      Production: https://app.motir.co
//   2. http://localhost:3000 — local development and tests, when it is unset.
//
// This replaced a four-rung chain (`BETTER_AUTH_URL`, then Vercel's injected
// `VERCEL_BRANCH_URL` / `VERCEL_URL` / `VERCEL_PROJECT_PRODUCTION_URL`). The
// platform-injected rungs are NOT re-pointed at Fly equivalents — they are
// deleted, because the thing they existed for is a per-deployment URL nobody
// configured, which is exactly what dropping preview environments removes.
// `BETTER_AUTH_URL` went with them: it is a library-specific name that had
// grown to govern email links, public-project URLs and signed assets, so it
// described its own scope less accurately every time it was reused.
//
// An EMPTY or whitespace-only value counts as unset. A secret cleared to `''`
// is a misconfiguration, and the old `??` would have let it through as an
// origin — turning every absolute link into a relative one silently.

const LOCAL_ORIGIN = 'http://localhost:3000';

/** The app's own absolute origin, exactly as configured (may carry a trailing slash). */
export function resolveBaseUrl(): string {
  const configured = process.env['MOTIR_BASE_URL']?.trim();
  return configured ? configured : LOCAL_ORIGIN;
}

/** The origin with any trailing slash trimmed — ready for path concatenation. */
export function resolveBaseUrlTrimmed(): string {
  return resolveBaseUrl().replace(/\/+$/, '');
}
