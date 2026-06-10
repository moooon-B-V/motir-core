import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { commentsService } from '@/lib/services/commentsService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import {
  CommentForbiddenError,
  CommentNotFoundError,
  EmptyCommentBodyError,
} from '@/lib/comments/errors';

// PATCH/DELETE /api/comments/[id] (Story 5.1 · Subtask 5.1.2) — edit / hard-
// delete one comment. Thin HTTP layer over commentsService; no db / no
// transaction here (CLAUDE.md).
//
// PATCH  { bodyMd: string } → 200 CommentDTO (sets the "Edited" tag)
// DELETE                    → 204 (the root cascade takes its replies; the
//                              History trace is the work_item_revision row)
//
// Typed errors → status codes (finding #44 — hidden / cross-workspace ids
// read as 404):
//   CommentNotFoundError / WorkItemNotFoundError / ProjectNotFoundError → 404
//   CommentForbiddenError                                              → 403
//   EmptyCommentBodyError                                              → 422

function mapCommentError(err: unknown): NextResponse | null {
  if (
    err instanceof CommentNotFoundError ||
    err instanceof WorkItemNotFoundError ||
    err instanceof ProjectNotFoundError
  ) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (err instanceof CommentForbiddenError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
  }
  if (err instanceof EmptyCommentBodyError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
  }
  return null;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

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
    const comment = await commentsService.editComment(id, { bodyMd }, ctx);
    return NextResponse.json(comment);
  } catch (err) {
    const mapped = mapCommentError(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id } = await params;

  try {
    await commentsService.deleteComment(id, ctx);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    const mapped = mapCommentError(err);
    if (mapped) return mapped;
    throw err;
  }
}
