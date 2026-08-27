import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { publicFollowService } from '@/lib/services/publicFollowService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import {
  FollowDigestUnavailableError,
  InvalidFollowEmailError,
} from '@/lib/publicProjects/followErrors';
import { enforcePublicFollowRateLimit } from '@/lib/rateLimit/publicFollowGuard';
import { normalizeFollowEmail } from '@/lib/publicProjects/followTokens';

// The EMAIL-ONLY subscribe (Story 8.9 · Subtask 8.9.5) — the tier that exists
// because a public project is a launch funnel and its visitor has no account.
//
// NOT session-gated: requiring sign-in here would delete the tier. Rate-limited
// on BOTH the caller's IP and the submitted ADDRESS, because an accepted request
// sends mail to an address the caller chose (`publicFollowGuard`).
//
// ⚠️ THE RESPONSE IS THE SAME WHATEVER HAPPENED — 202, no body. Already
// subscribed, newly subscribed, unconfirmed-and-re-sent: one answer. Varying it
// would turn this into an oracle for "does this address follow this project",
// which is exactly what an endpoint that accepts arbitrary addresses must not
// be (ADR §7). The two errors below are about the REQUEST, never about the row.

export async function POST(req: Request, { params }: { params: Promise<{ identifier: string }> }) {
  const { identifier } = await params;
  const session = await getSession();

  let email = '';
  try {
    const body = (await req.json()) as { email?: unknown };
    if (typeof body?.email === 'string') email = body.email;
  } catch {
    email = '';
  }

  // Limit BEFORE the work, keyed on the normalized address so casing cannot buy
  // a fresh bucket.
  const limited = await enforcePublicFollowRateLimit(req, normalizeFollowEmail(email));
  if (limited) return limited;

  try {
    await publicFollowService.subscribeByEmail(identifier, email, session?.user.id ?? null);
    return new NextResponse(null, { status: 202 });
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code }, { status: 404 });
    }
    if (err instanceof InvalidFollowEmailError) {
      return NextResponse.json({ code: err.code }, { status: 422 });
    }
    if (err instanceof FollowDigestUnavailableError) {
      return NextResponse.json({ code: err.code }, { status: 409 });
    }
    throw err;
  }
}
