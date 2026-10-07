import { NextResponse } from 'next/server';
import {
  authenticateServiceRequest,
  ServiceAuthError,
  SystemPrincipalNotProvisionedError,
} from '@/lib/ai/serviceAuth';
import { aiWorkItemsService } from '@/lib/services/aiWorkItemsService';
import { enforceInternalServiceRateLimit } from '@/lib/rateLimit/aiGuard';
import { ProjectNotFoundError, ProjectAccessDeniedError } from '@/lib/projects/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { FiledBugClosedError } from '@/lib/plans/errors';
import { CommentForbiddenError, EmptyCommentBodyError } from '@/lib/comments/errors';

// POST /api/internal/ai/work-items/{key}/comments (MOTIR-7722) — how motir-ai
// records a REPEAT planning failure: the same error code, session kind and
// model inside 24 hours comments on the bug the first one filed, instead of
// filing a second. The service-bearer sibling of `POST /api/internal/ai/work-items`.
//
// Auth: the MOTIR-1451 SERVICE bearer only, acting as the Motir SYSTEM
// principal. The service only comments on a `bug` that principal reported.
//
// Thin transport (the 4-layer rule): authenticate → validate → ONE service call
// (`aiWorkItemsService.commentOnFiledBug`) → map typed errors to status.
//
// Typed errors → status:
//   ServiceAuthError                     → 401
//   SystemPrincipalNotProvisionedError   → 500
//   ProjectNotFoundError / WorkItemNotFoundError → 404 (unknown key, or not a
//                                          bug the system principal filed)
//   ProjectAccessDeniedError             → 404 browse / 403 edit
//   CommentForbiddenError                → 403
//   FiledBugClosedError                  → 409 (archived or done: file a new bug)
//   EmptyCommentBodyError                → 400

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

function fail(code: string, error: string, status: number): NextResponse {
  return NextResponse.json({ code, error }, { status });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  let auth;
  try {
    auth = await authenticateServiceRequest(req);
  } catch (err) {
    if (err instanceof ServiceAuthError) return fail(err.code, err.message, 401);
    if (err instanceof SystemPrincipalNotProvisionedError) return fail(err.code, err.message, 500);
    throw err;
  }

  const limited = await enforceInternalServiceRateLimit(req);
  if (limited) return limited;

  const { key } = await params;
  if (!KEY_PATTERN.test(key)) {
    return fail('WORK_ITEM_NOT_FOUND', `No work item ${key}.`, 404);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail('COMMENTS_INVALID', 'request body must be valid JSON', 400);
  }
  const { bodyMd } = (body ?? {}) as Record<string, unknown>;
  if (typeof bodyMd !== 'string' || bodyMd.trim() === '') {
    return fail('COMMENTS_INVALID', '`bodyMd` is required.', 400);
  }

  try {
    const comment = await aiWorkItemsService.commentOnFiledBug(
      { identifier: key, bodyMd },
      auth.ctx,
    );
    return NextResponse.json({ id: comment.id }, { status: 201 });
  } catch (err) {
    if (err instanceof ProjectNotFoundError || err instanceof WorkItemNotFoundError) {
      return fail(err.code, err.message, 404);
    }
    if (err instanceof ProjectAccessDeniedError) {
      return fail(err.code, err.message, err.kind === 'browse' ? 404 : 403);
    }
    if (err instanceof CommentForbiddenError) return fail(err.code, err.message, 403);
    if (err instanceof FiledBugClosedError) return fail(err.code, err.message, 409);
    if (err instanceof EmptyCommentBodyError) return fail(err.code, err.message, 400);
    throw err;
  }
}
