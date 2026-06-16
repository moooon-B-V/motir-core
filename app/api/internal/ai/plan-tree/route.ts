import { NextResponse } from 'next/server';
import { authenticateJobRequest, JobAuthError } from '@/lib/ai/jobAuth';
import { aiBoundaryService } from '@/lib/services/aiBoundaryService';
import { ProjectNotFoundError } from '@/lib/projects/errors';

// GET /api/internal/ai/plan-tree (Subtask 7.1.6) — the ai→core read-back the
// planning job calls DURING a run to read the project's work-item skeleton.
// Service-to-service ONLY (the §4a service bearer + the §4b job token, both via
// authenticateJobRequest); never a cookie session, never CORS-exposed. Thin
// transport per CLAUDE.md: authenticate, ONE service call, map typed errors.
// The project is the TOKEN's project — there is no caller-supplied project, so a
// token can only ever read its own.
//
// Typed errors → status:
//   JobAuthError          → 401 (bad service bearer / missing-or-expired token)
//   ProjectNotFoundError  → 404 (the token's user can't browse it — never 403)
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

  try {
    const tree = await aiBoundaryService.readPlanTree(auth.projectId, auth.ctx);
    return NextResponse.json(tree);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
