import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { usersService } from '@/lib/services/usersService';
import {
  EmailChangeRateLimitedError,
  EmailTakenError,
  InvalidEmailError,
  SameEmailError,
  UserNotFoundError,
} from '@/lib/users/errors';

// POST /api/account/request-email-change (Subtask 8.8.22) — step 1 of a verified
// email change: the signed-in user asks to move their account to a new address.
// We record a pending request and email a confirm link to the NEW address; the
// swap happens only when that link is clicked (confirm-email-change). Personal,
// session-scoped (a user changes their OWN email), so the gate is `getSession`,
// not `getWorkspaceContext` — the appearance-preference route shape.
//
// Routes are HTTP-only (CLAUDE.md): parse → one service call → typed-error→status.
// The 200 body never reveals whether the target address exists (the service
// throws EmailTaken only when it's genuinely owned) and carries nothing
// sensitive — the token goes by email, never in the response.

export async function POST(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON object.' },
      { status: 400 },
    );
  }
  const { newEmail } = body as Record<string, unknown>;
  if (typeof newEmail !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`newEmail` must be a string.' },
      { status: 400 },
    );
  }

  try {
    await usersService.requestEmailChange(session.user.id, newEmail);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof InvalidEmailError)
      return NextResponse.json({ code: err.code }, { status: 400 });
    if (err instanceof SameEmailError)
      return NextResponse.json({ code: err.code }, { status: 400 });
    if (err instanceof EmailTakenError)
      return NextResponse.json({ code: err.code }, { status: 409 });
    if (err instanceof EmailChangeRateLimitedError)
      return NextResponse.json({ code: err.code }, { status: 429 });
    if (err instanceof UserNotFoundError)
      return NextResponse.json({ code: err.code }, { status: 401 });
    throw err;
  }
}
