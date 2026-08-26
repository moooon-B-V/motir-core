import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { twoFactorService } from '@/lib/services/twoFactorService';
import { UserNotFoundError } from '@/lib/users/errors';

// GET /api/account/two-factor/status (Story MOTIR-1213 · Subtask MOTIR-1218) —
// what the Security pane (MOTIR-1220) renders: whether a second factor is on,
// which methods can answer a challenge, and how much recovery is left.
//
// Personal and session-scoped (a user reads their OWN posture), so the gate is
// `getSession`, not `getWorkspaceContext` — the request-email-change route
// shape. The user id comes from the SESSION and is never accepted from the
// request: a `?userId=` would make this an enumeration of everyone's 2FA state.
//
// Routes are HTTP-only (CLAUDE.md): parse → one service call → typed-error →
// status. The body carries counts, never a secret — no TOTP seed, no code set.

export async function GET(): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  try {
    return NextResponse.json(await twoFactorService.getStatus(session.user.id));
  } catch (err) {
    // The session names a user that no longer exists — a deleted account on a
    // live cookie. 401, not 404: the right answer is "sign in again".
    if (err instanceof UserNotFoundError)
      return NextResponse.json({ code: err.code }, { status: 401 });
    throw err;
  }
}
