import { NextResponse } from 'next/server';
import { authenticateAndLimitJobRequest } from '@/lib/ai/jobAuth';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import { aiBoundaryService } from '@/lib/services/aiBoundaryService';
import { ProjectNotFoundError } from '@/lib/projects/errors';

// GET /api/internal/ai/pending-plans (MOTIR-4106) — the ai→core read-back that
// answers WHAT IS ALREADY PROPOSED on the token's project: the plans a person
// still has to decide about, newest first and bounded.
//
// ⚠️ IT IS A NEW READ, NOT A WIDENING OF `plan-proposals`. That route answers
// about the CALLER'S OWN plan and resolves it by `sourceJobId`, precisely so a
// job token cannot read another job's plan — a decision it records in its own
// header. This one answers a question about the PROJECT, so it stands beside it
// rather than inside it, and it returns no proposal CONTENT at all: an id, a
// title, a status, an age and a COUNT.
//
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
    auth = await authenticateAndLimitJobRequest(req);
  } catch (err) {
    const failure = mapJobRequestError(err);
    if (failure) return failure;
    throw err;
  }

  try {
    const pending = await aiBoundaryService.readPendingPlans(auth.projectId, auth.ctx);
    return NextResponse.json(pending);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
