import { NextResponse } from 'next/server';
import { readOperatorSession } from '@/lib/auth';
import {
  readStaffSessionToken,
  STAFF_SESSION_COOKIE,
  staffSessionCookieOptions,
} from '@/lib/platform/staffSession';
import { impersonationService } from '@/lib/services/impersonationService';

/**
 * `POST /api/staff-session/exit` — the staff session bar's **Exit session**
 * (Story 10.3 · MOTIR-749, design Panel 5).
 *
 * A plain form POST, not a Server Action: a READ-ONLY staff session refuses
 * Server Actions on tenant pages at the session chokepoint, and leaving a
 * session must work in every mode. So this reads the OPERATOR's own session
 * (`readOperatorSession` — never the impersonated identity), ends the session
 * the cookie names if it is theirs (audited `user.impersonation_end`,
 * `endedBy: operator`), clears the cookie, and 303s to the ended page.
 *
 * Not gated on `superadmin`: an operator demoted mid-session must still be able
 * to leave it. A cross-site POST carries no `sameSite: lax` session cookie, so it
 * ends nothing.
 */
export async function POST(req: Request) {
  const operator = await readOperatorSession(req.headers);
  const token = readStaffSessionToken(req.headers);

  let destination = operator ? '/dashboard' : '/sign-in';
  if (operator && token) {
    const ended = await impersonationService.endByToken(
      { userId: operator.user.id, sessionId: operator.session.id },
      token,
    );
    if (ended) destination = `/admin/staff-session/ended?session=${encodeURIComponent(ended.id)}`;
  }

  const res = NextResponse.redirect(new URL(destination, req.url), 303);
  res.cookies.set(STAFF_SESSION_COOKIE, '', {
    ...staffSessionCookieOptions(new Date(0)),
    maxAge: 0,
  });
  return res;
}
