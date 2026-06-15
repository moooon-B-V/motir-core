import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { publicRequestsService } from '@/lib/services/publicRequestsService';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { PublicRequestNotFoundError } from '@/lib/publicRequests/errors';

// POST /api/public-requests/[id]/upvote (Story 6.12 · Subtask 6.12.6) — toggle
// the signed-in account's upvote on a public request. Sign-in-to-act: the route
// requires a session but NOT workspace membership (the vote is cross-org —
// `getSession`, not `getWorkspaceContext`); the service enforces the public
// project + the `canUpvotePublicRequest` grant. Thin HTTP layer (CLAUDE.md).
//
//   POST → 200 { voted: boolean, voteCount: number }
//
// Typed errors → status codes (404-not-403 posture for a non-public / missing
// request — no existence leak):
//   PublicRequestNotFoundError / ProjectNotFoundError        → 404
//   ProjectAccessDeniedError                                 → 403

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id } = await params;
  try {
    const result = await publicRequestsService.toggleUpvote(id, { userId: session.user.id });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof PublicRequestNotFoundError || err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof ProjectAccessDeniedError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
    }
    throw err;
  }
}
