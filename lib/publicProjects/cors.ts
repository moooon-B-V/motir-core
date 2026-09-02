import { publicSiteOrigin } from '@/lib/publicProjects/urls';

// CROSS-ORIGIN ACCESS TO THE PUBLIC READ SURFACE (MOTIR-4114 ·
// `public-surface-hosts.md` AMENDMENT 3 §D, row 3 and the ANONYMOUS-DIRECT
// mechanism).
//
// ── Who needs this, and who does not ──────────────────────────────────────
//
// `motir.co` renders `/p/*` server-side, and a server-side fetch needs no CORS
// at all — CORS is a browser rule, not a network one. What DOES need it is
// every fetch the rendered page then makes from the BROWSER: paging an items
// list, expanding a tree level, loading the next roadmap column, and the email
// subscribe. Those are cross-origin XHRs from `motir.co` to `app.motir.co`, and
// without these headers the browser discards the response after the server has
// already computed it.
//
// ── ⚠️ NO CREDENTIALS, AND THAT IS WHAT MAKES THE ALLOW-LIST CHEAP ────────
//
// `Access-Control-Allow-Credentials` is NEVER set, and no route reachable this
// way requires a session. So the allow-list is a convenience for the browser,
// not a trust boundary: a request arriving here carries no cookie, no
// `Authorization` and no ambient authority, and would be answered identically
// from `curl`. Everything it can reach is public by construction.
//
// That also means the four session-required routes are deliberately NOT covered
// (`follow`, the request intake, its duplicate pre-check, and — under their own
// namespace — upvote and comment). Advertising them cross-origin would suggest a
// credentialed call is possible when `sameSite: 'lax'` already guarantees it is
// not, and the honest mechanism for those is the HAND-OFF (`app/act/route.ts`).
//
// ── One origin, from the one module that answers "where is the public site?" ─
//
// The allowed origin is `publicSiteOrigin()`, never `*`. Not because a wildcard
// would be unsafe here — with no credentials it would be equivalent — but
// because it would be a claim we do not mean: this surface exists to be read by
// one site, and a wildcard invites a consumer to build on an origin policy
// nobody decided. `Vary: Origin` is set alongside, so a shared cache cannot
// serve one origin's allow header to another.

/** The request headers a browser may send on a public read. */
const ALLOWED_REQUEST_HEADERS = 'Content-Type';

/** The methods the public surface answers. `OPTIONS` is the preflight itself. */
const ALLOWED_METHODS = 'GET, POST, DELETE, OPTIONS';

/** How long a browser may cache the preflight, in seconds. */
const PREFLIGHT_MAX_AGE = '86400';

/**
 * The CORS headers for a request from `origin`, or `null` when that origin is
 * not the configured public site.
 *
 * Returning `null` rather than a refusal is deliberate: CORS is enforced by the
 * BROWSER, so the correct answer to a disallowed origin is to send no CORS
 * headers at all and let the browser refuse. Sending an explicit denial would be
 * theatre, and refusing to answer would break every non-browser caller — `curl`,
 * a crawler, a feed reader — which send no `Origin` and are entitled to the same
 * public data.
 */
export function publicCorsHeaders(origin: string | null): Record<string, string> | null {
  if (origin === null || origin !== publicSiteOrigin()) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    // Without this, a shared cache can hand a response carrying one origin's
    // allow header to a request from another.
    Vary: 'Origin',
  };
}

/** The extra headers a PREFLIGHT (`OPTIONS`) answer carries, beyond the above. */
export function publicCorsPreflightHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Access-Control-Allow-Headers': ALLOWED_REQUEST_HEADERS,
    'Access-Control-Max-Age': PREFLIGHT_MAX_AGE,
  };
}
