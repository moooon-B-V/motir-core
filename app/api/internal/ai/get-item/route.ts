import { NextResponse } from 'next/server';
import { authenticateJobRequest, JobAuthError } from '@/lib/ai/jobAuth';
import { aiBoundaryService } from '@/lib/services/aiBoundaryService';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';

// GET /api/internal/ai/get-item?key=MOTIR-7[&withComments=1][&withHistory=1]
//   [&commentsCursor=…][&historyCursor=…]  (Subtask 7.5.1)
//
// One work item by key, plus (on request) the DEPTH context 7.1.6 deferred: the
// cursor-paginated comment thread and the cursor-paginated change log — the
// signal a planner uses to understand WHY an item is shaped the way it is.
// Service-to-service ONLY (the §4a service bearer + §4b job token via
// authenticateJobRequest); the item is resolved AS the token's user within the
// token's project, so a cross-tenant / cross-project key is a 404, never a leak.
//
// Typed errors → status:
//   JobAuthError                       → 401
//   WorkItemNotFoundError              → 404 (absent / cross-tenant — no leak)
//   ProjectAccessDeniedError('browse') → 404 (a project the user can't browse)
function parseBool(v: string | null): boolean {
  return v === '1' || v === 'true';
}

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
  const commentsCursor = url.searchParams.get('commentsCursor');
  const historyCursor = url.searchParams.get('historyCursor');

  try {
    const result = await aiBoundaryService.getItem(auth.projectId, key, auth.ctx, {
      withComments: parseBool(url.searchParams.get('withComments')),
      withHistory: parseBool(url.searchParams.get('withHistory')),
      ...(commentsCursor ? { commentsCursor } : {}),
      ...(historyCursor ? { historyCursor } : {}),
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
