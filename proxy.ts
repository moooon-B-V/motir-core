import { NextResponse, type NextRequest } from 'next/server';
import { getSessionCookie } from 'better-auth/cookies';

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

export function proxy(request: NextRequest) {
  const sessionCookie = getSessionCookie(request);
  if (!sessionCookie) {
    const signInUrl = new URL('/sign-in', request.url);
    signInUrl.searchParams.set('next', request.nextUrl.pathname);
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
  // Every URL that maps to a page under `app/(authed)/`, plus the two other
  // signed-in route groups (`(onboarding)`, `(planning)`).
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
