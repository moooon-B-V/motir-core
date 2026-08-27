import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { publicFollowService } from '@/lib/services/publicFollowService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { enforcePublicFollowRateLimit } from '@/lib/rateLimit/publicFollowGuard';

// The ACCOUNT follow toggle (Story 8.9 · Subtask 8.9.5). Unlike the public READ
// routes beside it, this one IS session-gated: following is a relationship
// between an account and a project, so a signed-out caller has nothing to
// create. The anonymous tier subscribes to the feed and stores nothing; the
// email-only tier goes through `../subscribe`.
//
// HTTP layer only: rate-limit → parse → one service call → map errors. Both
// verbs are IDEMPOTENT at the service, so a double-click or a retried request
// answers the resulting STATE rather than a conflict.

async function requireSession() {
  const session = await getSession();
  return session?.user.id ?? null;
}

/** Follow, or update the digest opt-in on an existing follow. */
export async function POST(req: Request, { params }: { params: Promise<{ identifier: string }> }) {
  const { identifier } = await params;
  const actorUserId = await requireSession();
  if (!actorUserId) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const limited = await enforcePublicFollowRateLimit(req);
  if (limited) return limited;

  let digestOptIn: boolean | undefined;
  try {
    const body = (await req.json()) as { digestOptIn?: unknown };
    if (typeof body?.digestOptIn === 'boolean') digestOptIn = body.digestOptIn;
  } catch {
    // A bodiless POST is the plain "follow" case — not an error.
  }

  try {
    const state = await publicFollowService.followAsAccount(identifier, actorUserId, {
      ...(digestOptIn === undefined ? {} : { digestOptIn }),
    });
    return NextResponse.json(state);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code }, { status: 404 });
    }
    throw err;
  }
}

/** Unfollow. */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ identifier: string }> },
) {
  const { identifier } = await params;
  const actorUserId = await requireSession();
  if (!actorUserId) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const limited = await enforcePublicFollowRateLimit(req);
  if (limited) return limited;

  try {
    const state = await publicFollowService.unfollowAsAccount(identifier, actorUserId);
    return NextResponse.json(state);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code }, { status: 404 });
    }
    throw err;
  }
}
