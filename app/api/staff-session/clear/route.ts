import { NextResponse } from 'next/server';
import { readOperatorSession, readSession } from '@/lib/auth';
import {
  readStaffSessionToken,
  STAFF_SESSION_COOKIE,
  staffSessionCookieOptions,
} from '@/lib/platform/staffSession';
import { impersonationService } from '@/lib/services/impersonationService';

/**
 * `GET /api/staff-session/clear` — where a request carrying a STALE staff-session
 * cookie is sent (Story 10.3 · MOTIR-749, design Panel 5c).
 *
 * The gate answers a session that is over (expired, ended, revoked) as signed
 * out — fail closed — so the `(authed)` layout redirects here, and so does the
 * bar when the time-box runs out on an open page. This records the end of an
 * EXPIRED session if nothing has yet (`endedBy: expiry`), clears the cookie, and
 * sends the operator to the ended page (their own session) or home.
 *
 * ⚠️ IT NEVER CUTS A LIVE SESSION SHORT. A GET is reachable from a link, so a
 * session the gate still finds ACTIVE is left exactly as it is — cookie and all —
 * and the request is sent back into the app. Only `settleStaleToken`'s
 * past-its-box arm writes anything.
 */
export async function GET(req: Request) {
  const token = readStaffSessionToken(req.headers);
  if (!token) return NextResponse.redirect(new URL('/dashboard', req.url), 303);

  const effective = await readSession(req.headers, { method: 'GET' });
  if (effective?.impersonation) {
    return NextResponse.redirect(new URL('/dashboard', req.url), 303);
  }

  const operator = await readOperatorSession(req.headers);
  const settled = await impersonationService.settleStaleToken(token, operator?.user.id ?? null);
  const destination =
    settled.sessionId && settled.operatorMatches
      ? `/admin/staff-session/ended?session=${encodeURIComponent(settled.sessionId)}`
      : operator
        ? '/dashboard'
        : '/sign-in';

  const res = NextResponse.redirect(new URL(destination, req.url), 303);
  res.cookies.set(STAFF_SESSION_COOKIE, '', {
    ...staffSessionCookieOptions(new Date(0)),
    maxAge: 0,
  });
  return res;
}
