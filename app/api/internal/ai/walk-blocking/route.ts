import { NextResponse } from 'next/server';
import { authenticateJobRequest, JobAuthError } from '@/lib/ai/jobAuth';
import { aiBoundaryService } from '@/lib/services/aiBoundaryService';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';

// GET /api/internal/ai/walk-blocking?key=MOTIR-7[&maxDepth=25][&maxNodes=200]
//   (Subtask 7.5.1)
//
// The transitive `is_blocked_by` closure of an item — "what must land before
// this". Cycle-safe (visited-set) and bounded (node + depth caps CLAMPED in the
// service) so a pathological graph can't exhaust the job (finding #57).
// `truncated` in the body flags a walk stopped at a cap. Service-to-service
// ONLY; the root is resolved AS the token's user within the token's project, and
// the walk is scoped to that project, so a cross-tenant key is a 404.
//
// Typed errors → status:
//   JobAuthError                       → 401
//   WorkItemNotFoundError              → 404 (absent / cross-tenant root)
//   ProjectAccessDeniedError('browse') → 404
export async function GET(req: Request): Promise<Response> {
  let auth;
  try {
    auth = authenticateJobRequest(req);
  } catch (err) {
    if (err instanceof JobAuthError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: err.httpStatus });
    }
    throw err;
  }

  const url = new URL(req.url);
  const key = url.searchParams.get('key');
  if (!key) {
    return NextResponse.json(
      { code: 'KEY_REQUIRED', error: '`key` is required.' },
      { status: 400 },
    );
  }
  const maxDepthParam = url.searchParams.get('maxDepth');
  const maxNodesParam = url.searchParams.get('maxNodes');

  try {
    const result = await aiBoundaryService.walkBlocking(auth.projectId, key, auth.ctx, {
      ...(maxDepthParam !== null ? { maxDepth: Number(maxDepthParam) } : {}),
      ...(maxNodesParam !== null ? { maxNodes: Number(maxNodesParam) } : {}),
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof WorkItemNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof ProjectAccessDeniedError) {
      return NextResponse.json(
        { code: err.code, error: err.message },
        { status: err.kind === 'browse' ? 404 : 403 },
      );
    }
    throw err;
  }
}
