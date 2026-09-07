import { NextResponse, type NextRequest } from 'next/server';
import { getSessionCookie } from 'better-auth/cookies';
import { publicSiteOrigin } from '@/lib/publicProjects/urls';
import { publicCorsHeaders, publicCorsPreflightHeaders } from '@/lib/publicProjects/cors';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';

// Optimistic cookie-presence check on every incoming request to a
// protected route: if no session cookie is present, bounce to /sign-in.
// This is the pattern Better-Auth recommends — full session validation
// (a DB call) is too expensive to run on every request. Each protected
// page/route still re-checks the session server-side via `getSession()`
// for actual enforcement.
//
// Next.js 16 renamed the `middleware.ts` file convention to `proxy.ts`
// (https://nextjs.org/docs/messages/middleware-to-proxy). The exported
// function is now `proxy`, and Proxy defaults to the Node.js runtime
// rather than Edge — Better-Auth's `getSessionCookie` works in both.
//
// The matcher below targets the /app/(authed)/* route group. The (authed)
// segment is a Next.js route group — it groups files but doesn't add a
// URL segment — so its children are matched by their actual URL paths.
// We list those URL paths in `config.matcher` rather than trying to match
// the route-group name.

/**
 * The request header carrying the path the visitor actually asked for
 * (MOTIR-3652). A Next.js **layout** — the only place every signed-in page
 * reliably passes through — has no supported way to learn the current URL, so
 * the edge forwards it and the layout reads it back with `headers()`.
 *
 * ⚠️ **ADVISORY, ABSENT OFF-MATCHER, AND FORGEABLE.** Three properties every
 * consumer must treat as load-bearing, stated here at the header's source
 * rather than left for each reader to rediscover:
 *
 * 1. **Advisory.** It is a hint about where the visitor was going, never an
 *    authorization input. Nothing may be granted or denied on its value.
 * 2. **Absent off-matcher.** `config.matcher` below decides where the proxy
 *    runs at all, so a request to any path it does not cover arrives with no
 *    such header. `headers().get(CURRENT_PATH_HEADER)` returning `null` is a
 *    normal state, not an error.
 * 3. **Forgeable.** A client can send `x-current-path: https://evil.example`
 *    with any request. `proxy()` OVERWRITES it on every request it handles
 *    (see below), so a covered path is safe — but a consumer that reads it
 *    must still not assume the proxy ran.
 *
 * **So a consumer using it as a REDIRECT TARGET must first validate it as a
 * same-origin relative path** — a leading `/`, no scheme, no protocol-relative
 * `//`, no `..` segment — and fall back to a fixed safe destination otherwise.
 * An unvalidated redirect target taken from a request header is an
 * open-redirect, and it is the one way this small piece of plumbing could ship
 * a vulnerability. The first (and, today, only) consumer is MOTIR-3648's
 * forced-enrolment gate, which sends a person back where they were going once
 * they have enrolled.
 */
export const CURRENT_PATH_HEADER = 'x-current-path';

/**
 * The top-level URL segments that have MOVED to the public site (MOTIR-3884).
 * `''` is the root `/`. The proxy 308s these to `motir.co` (the public origin)
 * once `MOTIR_PUBLIC_SITE_URL` is configured, path and query preserved.
 *
 * `/p/*` is included. Its move to `motir.co` is MOTIR-3877's (which renders the
 * replacement), but the redirect ships here and MOTIR-3951 deletes the page from
 * this application — so `/p/*` must 308 onto the public host, not 404.
 */
export const PUBLIC_REDIRECT_SEGMENTS = new Set(['', 'explore', 'docs', 'legal', 'p']);

/**
 * Redirect a moved public surface to the public origin, or `null` when this
 * request is not one. Gated on the public origin being CONFIGURED: while
 * `MOTIR_PUBLIC_SITE_URL` is unset, `publicSiteOrigin()` falls back to THIS
 * origin and a redirect would loop — so nothing fires until the cutover card
 * points the public origin at `motir.co`.
 */
function publicSiteRedirect(request: NextRequest): NextResponse | null {
  if (publicSiteOrigin() === resolveBaseUrlTrimmed()) return null;
  const segment = request.nextUrl.pathname.split('/')[1] ?? '';
  if (!PUBLIC_REDIRECT_SEGMENTS.has(segment)) return null;
  const destination = new URL(
    request.nextUrl.pathname + request.nextUrl.search,
    publicSiteOrigin(),
  );
  return NextResponse.redirect(destination, 308);
}

/**
 * The PUBLIC READ SURFACE's cross-origin answer (MOTIR-4114 ·
 * `public-surface-hosts.md` AMENDMENT 4 §D).
 *
 * `motir.co` renders `/p/*` server-side, and a server-side fetch needs no CORS.
 * What needs it is every fetch the RENDERED PAGE then makes from the browser —
 * paging an items list, expanding a tree level, loading the next roadmap column,
 * subscribing by email. Handled here rather than in nine route files for one
 * reason: a route added later inherits it. A per-route header is a rule in a
 * comment, and `tests/api/public/cloud-gate-totality.test.ts` exists because
 * that is what happens to those.
 *
 * ⚠️ NO `Access-Control-Allow-Credentials`, EVER. Nothing reachable this way
 * requires a session, so the header set below is a convenience for the browser
 * rather than a trust boundary: such a request carries no cookie (`sameSite:
 * 'lax'` already guarantees that) and would be answered identically from
 * `curl`. `lib/publicProjects/cors.ts` carries the reasoning.
 *
 * An origin that is not the public site gets NO cors headers and an ordinary
 * response — the browser refuses it, which is where CORS is enforced. A caller
 * that sends no `Origin` at all (a crawler, a feed reader, `curl`) is untouched.
 */
async function publicSurfaceCors(request: NextRequest): Promise<NextResponse | null> {
  if (!request.nextUrl.pathname.startsWith('/api/public/')) return null;

  const allow = await publicCorsHeaders(request.headers.get('origin'));

  // A PREFLIGHT is answered here and goes no further: it is a question about
  // the NEXT request, so running it through a route handler would execute a
  // read nobody asked for.
  if (request.method === 'OPTIONS') {
    const headers = { ...(allow ?? {}), ...(allow ? publicCorsPreflightHeaders() : {}) };
    return new NextResponse(null, { status: 204, headers });
  }

  // ⚠️ AND IT ALWAYS TERMINATES, EVEN WITH NOTHING TO ALLOW. Returning `null`
  // here — "no cors headers needed, carry on" — drops the request into the
  // session bounce below, which 307s an ANONYMOUS API call to `/sign-in`. That
  // is every caller with no `Origin` header: `curl`, a crawler, a feed reader,
  // and `motir-marketing`'s own server-side fetches, which are how `motir.co`
  // renders in the first place. The matcher entry is for CORS and for nothing
  // else, so this branch owns every path under it.
  const response = NextResponse.next();
  for (const [name, value] of Object.entries(allow ?? {})) response.headers.set(name, value);
  return response;
}

export async function proxy(request: NextRequest) {
  // The public READ API's cross-origin answer (MOTIR-4114) — first, because a
  // preflight is answered here and never reaches a handler, and because these
  // paths are an API rather than a page: none of the page logic below applies
  // to them.
  const cors = await publicSurfaceCors(request);
  if (cors) return cors;

  // The moved public surfaces leave this application first (MOTIR-3884): they
  // are answered on motir.co now, so the session bounce below is not theirs.
  const moved = publicSiteRedirect(request);
  if (moved) return moved;

  // While MOTIR_PUBLIC_SITE_URL is unset the moved surfaces are still served
  // HERE — the root `/` runs its own session handling in `app/page.tsx` (no
  // session → `/sign-in`, session → `/home`), and the deleted pages 404. They
  // are NOT protected routes, so forward them untouched rather than bouncing a
  // cookie-less request to `/sign-in?next=…` (which would shadow the root's
  // own contract and turn a deleted page's 404 into a sign-in redirect).
  const segment = request.nextUrl.pathname.split('/')[1] ?? '';
  if (PUBLIC_REDIRECT_SEGMENTS.has(segment)) {
    return NextResponse.next();
  }

  const sessionCookie = getSessionCookie(request);
  if (!sessionCookie) {
    const signInUrl = new URL('/sign-in', request.url);
    // ⚠️ THE SEARCH STRING IS PART OF THE DESTINATION (MOTIR-4725). This used to
    // set the PATHNAME alone, which cost a filtered list its filter and — since
    // the planning workspace became an OVERLAY whose whole open state lives in
    // the query — costs a shared planner link the planner itself: a signed-out
    // reader following `/backlog?plan=project&planFrom=project` arrived at a bare
    // backlog with nothing to say what they had been sent to see. The value is
    // the same one the `x-current-path` header below carries for the signed-in
    // half of this function, and it stays a same-origin PATH, which is what
    // `sanitizeNextPath` (`lib/navigation/nextDestination.ts`) admits — a query
    // has always been legal in it (`/device?user_code=…` is the older instance).
    signInUrl.searchParams.set('next', `${request.nextUrl.pathname}${request.nextUrl.search}`);
    return NextResponse.redirect(signInUrl);
  }

  // Forward the requested path to the layouts underneath (MOTIR-3652).
  //
  // `NextResponse.next({ request: { headers } })` is the version-sensitive API:
  // Next 16's `MiddlewareResponseInit.request.headers` overrides the headers the
  // downstream render sees, and it is still the only supported way to hand a
  // Server Component a per-request value the framework does not already expose.
  // Verified against the pinned `next@16.2.6`
  // (`next/dist/server/web/spec-extension/response.d.ts`), which offers no
  // first-class pathname accessor for a layout. If a future version ships one,
  // use it and delete this.
  //
  // The header is copied from the incoming request and then SET, so a
  // client-supplied `x-current-path` is overwritten rather than honoured.
  //
  // Search string included: a filtered list URL (`/items?status=open`) must
  // survive the round trip, or a visitor stopped on the way there is returned to
  // an unfiltered page.
  //
  // Set on the forwarded REQUEST only, never on the response — nothing about a
  // route's caching or revalidation behaviour changes.
  const headers = new Headers(request.headers);
  headers.set(CURRENT_PATH_HEADER, `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Every URL that maps to a page under `app/(authed)/`, plus the one other
  // signed-in route group, `(onboarding)`.
  //
  // ⚠️ `/planning` STAYS ON THIS LIST although its route group is gone
  // (MOTIR-4732). The workspace is an overlay now and `app/(authed)/planning`
  // holds only a FORWARD for old links — and that forward is exactly why the
  // entry matters: without it a cookie-less request to a bookmarked
  // `/planning?…` gets the segment's own gate instead of the
  // `/sign-in?next=/planning…` bounce this matcher exists to give it.
  //
  // ⚠️ THIS LIST IS GUARDED, NOT REMEMBERED (MOTIR-3652). It used to carry a
  // comment asking future authors to append each new authed route, and thirteen
  // of the sixteen `(authed)` segments were never added — which is what happens
  // to every rule that lives in a comment. `tests/navigation/proxy-matcher.test.ts`
  // now enumerates the segments from the filesystem and fails when one has no
  // entry here, so adding an authed segment without a matcher entry turns the
  // suite red.
  //
  // What the missing entries cost was never a security hole — the real gate is
  // `app/(authed)/layout.tsx`'s `getSession()` redirect, and it has always run
  // for all sixteen. They cost the cheap optimistic bounce, and (since this
  // card) the `x-current-path` header above, which is absent for any path the
  // matcher does not cover.
  //
  // ⚠️ `/admin` IS DELIBERATELY NOT HERE, and adding it would break a security
  // posture rather than tighten one (`docs/decisions/platform-staff-auth.md`
  // §2, MOTIR-2896). The redirect above is VISIBLY DIFFERENT from an unknown
  // path's 404, so a cookie-less request bounced to `/sign-in?next=/admin`
  // proves the route is real — which is exactly what the admin area's
  // 404-not-403 posture exists to prevent. An anonymous request must instead
  // reach `app/(admin)/layout.tsx` and be answered there by
  // `requirePlatformStaff()` with the ordinary 404. It costs nothing: that
  // layout makes the same session read every authed page already makes.
  matcher: [
    // The MOVED public surfaces (MOTIR-3884) — the proxy runs on them to 308
    // them onto motir.co. `/p/*` IS here: its move to motir.co was folded into
    // this redirect set (MOTIR-3877 renders the replacement; MOTIR-3951 deletes
    // the page here), so it must 308, not 404.
    // The public READ API — matched for CORS only (MOTIR-4114). Everything
    // below this line is a PAGE and takes the session bounce; this one is an
    // API path and takes only the cross-origin answer, which `proxy()` handles
    // before any of it.
    '/api/public/:path*',
    '/',
    '/explore/:path*',
    '/docs/:path*',
    '/legal/:path*',
    '/p/:path*',
    '/backlog/:path*',
    '/boards/:path*',
    '/code-health/:path*',
    '/dashboard/:path*',
    '/direction/:path*',
    '/filters/:path*',
    '/home/:path*',
    '/invite/:path*',
    '/items/:path*',
    '/onboarding/:path*',
    '/planning/:path*',
    '/plans/:path*',
    '/ready/:path*',
    '/reports/:path*',
    '/roadmap/:path*',
    '/runs/:path*',
    '/settings/:path*',
    '/sprints/:path*',
    '/triage/:path*',
  ],
};
