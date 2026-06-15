import { NextResponse } from 'next/server';
import { authenticateJobRequest, JobAuthError } from '@/lib/ai/jobAuth';
import { aiBoundaryService } from '@/lib/services/aiBoundaryService';
import { parsePlanDelta, PlanDeltaValidationError } from '@/lib/ai/planDelta';
import { ProjectNotFoundError } from '@/lib/projects/errors';

// POST /api/internal/ai/plan-delta (Subtask 7.1.6) — the ONLY write path the AI
// has: motir-ai submits the proposed tree-delta, motir-core validates + commits
// it THROUGH workItemsService (every 6.4 permission + tenant guard applies, as
// the token's user). Service-to-service only (§4a + §4b, via
// authenticateJobRequest). An empty delta is a valid no-op (what 7.1.7's `noop`
// sends). Thin transport: authenticate, parse, ONE service call, map errors.
//
// Typed errors → status:
//   JobAuthError              → 401
//   PlanDeltaValidationError  → 400 (malformed delta / unresolved ref / bad op)
//   ProjectNotFoundError      → 404
export async function POST(req: Request): Promise<Response> {
  let auth;
  try {
    auth = authenticateJobRequest(req);
  } catch (err) {
    if (err instanceof JobAuthError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: err.httpStatus });
    }
    throw err;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'PLAN_DELTA_INVALID', error: 'request body must be valid JSON' },
      { status: 400 },
    );
  }

  try {
    const delta = parsePlanDelta(body);
    const result = await aiBoundaryService.commitPlanDelta(auth.projectId, delta, auth.ctx);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof PlanDeltaValidationError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
    }
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
