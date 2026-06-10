import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { commentsService } from '@/lib/services/commentsService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import {
  CommentForbiddenError,
  CommentNotFoundError,
  EmptyCommentBodyError,
  InvalidParentCommentError,
  ReplyDepthExceededError,
} from '@/lib/comments/errors';

// GET/POST /api/work-items/[id]/comments (Story 5.1 · Subtask 5.1.2) — the
// issue's comment threads. Thin HTTP layer over commentsService; no db / no
// transaction here (CLAUDE.md).
//
// GET  ?cursor=<rootCommentId>&order=asc|desc   → one CommentsPageDTO window
// POST { bodyMd: string, parentCommentId?: string | null } → 201 CommentDTO
//
// Typed errors → status codes (finding #44 — a hidden / cross-workspace id
// reads as 404, never "exists but forbidden"):
//   WorkItemNotFoundError / ProjectNotFoundError / CommentNotFoundError → 404
//   CommentForbiddenError                                              → 403
//   EmptyCommentBodyError / InvalidParentCommentError /
//   ReplyDepthExceededError                                            → 422

function mapCommentError(err: unknown): NextResponse | null {
  if (
    err instanceof WorkItemNotFoundError ||
    err instanceof ProjectNotFoundError ||
    err instanceof CommentNotFoundError
  ) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (err instanceof CommentForbiddenError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
  }
  if (
    err instanceof EmptyCommentBodyError ||
    err instanceof InvalidParentCommentError ||
    err instanceof ReplyDepthExceededError
  ) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
  }
  return null;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id } = await params;
  const url = new URL(req.url);
  const cursor = url.searchParams.get('cursor') ?? undefined;
  const orderParam = url.searchParams.get('order');
  if (orderParam !== null && orderParam !== 'asc' && orderParam !== 'desc') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`order` must be "asc" or "desc".' },
      { status: 400 },
    );
  }

  try {
    const page = await commentsService.listComments(
      id,
      { cursor, order: orderParam ?? undefined },
      ctx,
    );
    return NextResponse.json(page);
  } catch (err) {
    const mapped = mapCommentError(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function POST(
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

  const { bodyMd, parentCommentId } = (body ?? {}) as Record<string, unknown>;
  if (typeof bodyMd !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`bodyMd` must be a string.' },
      { status: 400 },
    );
  }
  if (
    parentCommentId !== undefined &&
    parentCommentId !== null &&
    typeof parentCommentId !== 'string'
  ) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`parentCommentId` must be a string or null.' },
      { status: 400 },
    );
  }

  try {
    const comment = await commentsService.addComment(id, { bodyMd, parentCommentId }, ctx);
    return NextResponse.json(comment, { status: 201 });
  } catch (err) {
    const mapped = mapCommentError(err);
    if (mapped) return mapped;
    throw err;
  }
}
