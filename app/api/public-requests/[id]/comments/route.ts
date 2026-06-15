import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { publicRequestsService } from '@/lib/services/publicRequestsService';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { PublicRequestNotFoundError } from '@/lib/publicRequests/errors';
import { EmptyCommentBodyError } from '@/lib/comments/errors';

// POST /api/public-requests/[id]/comments (Story 6.12 · Subtask 6.12.6) — add a
// PUBLIC-visible comment to a public request, attributed to the signed-in
// (cross-org) account. Sign-in-to-act: a session is required but NOT workspace
// membership (`getSession`, not `getWorkspaceContext`); the service enforces the
// public project + the `canCommentPublicRequest` grant and marks the comment
// `isPublic` (the 6.12.2 §4 split — these show on the public surface; the work
// item's internal thread does not). Thin HTTP layer (CLAUDE.md).
//
//   POST { bodyMd: string } → 201 CommentDTO
//
// Typed errors → status codes:
//   PublicRequestNotFoundError / ProjectNotFoundError → 404
//   ProjectAccessDeniedError                          → 403
//   EmptyCommentBodyError                             → 422

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }

  const { bodyMd } = (body ?? {}) as Record<string, unknown>;
  if (typeof bodyMd !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`bodyMd` must be a string.' },
      { status: 400 },
    );
  }

  try {
    const comment = await publicRequestsService.addComment(
      id,
      { bodyMd },
      { userId: session.user.id },
    );
    return NextResponse.json(comment, { status: 201 });
  } catch (err) {
    if (err instanceof PublicRequestNotFoundError || err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof ProjectAccessDeniedError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
    }
    if (err instanceof EmptyCommentBodyError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
    }
    throw err;
  }
}
