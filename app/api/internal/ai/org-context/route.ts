import { NextResponse } from 'next/server';
import { authenticateJobRequest, JobAuthError } from '@/lib/ai/jobAuth';
import { aiBoundaryService } from '@/lib/services/aiBoundaryService';
import { OrganizationNotFoundError } from '@/lib/organizations/errors';

// GET /api/internal/ai/org-context (Subtask 7.3.45) — the ai→core read-back the
// discovery interview calls to weigh the calling ORG's existing footprint when
// it classifies a new project (an org already running several projects with a
// multi-person team skews startup/enterprise, not a first hobby project).
// Service-to-service ONLY (the §4a service bearer + the §4b job token, both via
// authenticateJobRequest); never a cookie session, never CORS-exposed. Thin
// transport per CLAUDE.md: authenticate, ONE service call, map typed errors. The
// org is the TOKEN's workspace's parent — there is no caller-supplied org, so a
// token can only ever read its own org's footprint, AS its own user.
//
// Typed errors → status:
//   JobAuthError              → 401 (bad service bearer / missing-or-expired token)
//   OrganizationNotFoundError → 404 (the token's user can't reach the workspace/org — never 403)
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
    const orgContext = await aiBoundaryService.readOrgContext(auth.ctx);
    return NextResponse.json(orgContext);
  } catch (err) {
    if (err instanceof OrganizationNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
