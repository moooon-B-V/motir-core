import { NextResponse } from 'next/server';
import { authenticateAndLimitJobRequest } from '@/lib/ai/jobAuth';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import { aiGenerationService } from '@/lib/services/aiGenerationService';
import { NoPlanForJobError, PlanNotFoundError } from '@/lib/plans/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';

// POST /api/internal/ai/plan-revision-lease (Bug MOTIR-8523) — the hosted revision's
// HEARTBEAT. motir-ai's worker calls it on a timer while a revision job runs, so the
// revision lease core took at submit keeps the plan while the job's conversation and
// author sessions run past the lease window without writing the plan's trail. It is
// the job's twin of the MCP `hold_plan_revision { action: 'renew' }`: one
// `revision_renewed` row, which the timeline drops.
//
// It never TAKES a lease. A lapsed lease, a released one and a hold somebody else
// took all answer `200 { renewed: false }` and write nothing, so the caller stops
// renewing; nothing here can re-hold a plan a person may already be deciding.
//
// Auth: §4a service bearer + §4b job token (`authenticateAndLimitJobRequest`), as
// `plan-revision-reason` and `plan-step`. The plan is the JOB's (`sourceJobId`);
// `planId` is a cross-check and a mismatch is the same 404 a foreign job gets.
//
// Thin transport (the 4-layer rule): authenticate → validate → ONE service call →
// map typed errors.
//
// Typed errors → status (the family's `{ code, error }` shape):
//   JobAuthError                          → 401 (bad service bearer / missing-expired token)
//   PLAN_REVISION_LEASE_INVALID           → 400 (body shape)
//   NoPlanForJobError / PlanNotFoundError → 404 (no plan for this job in the token's
//                                                project and tenant, or a mismatched planId)
//   ProjectAccessDeniedError              → 404 browse / 403 edit

function fail(code: string, error: string, status: number): NextResponse {
  return NextResponse.json({ code, error }, { status });
}

const INVALID = 'PLAN_REVISION_LEASE_INVALID';

export async function POST(req: Request): Promise<Response> {
  let auth;
  try {
    auth = await authenticateAndLimitJobRequest(req);
  } catch (err) {
    const failure = mapJobRequestError(err);
    if (failure) return failure;
    throw err;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(INVALID, 'request body must be valid JSON', 400);
  }
  const { jobId, planId, model } = (body ?? {}) as Record<string, unknown>;

  if (typeof jobId !== 'string' || jobId.trim() === '') {
    return fail(INVALID, '`jobId` is required.', 400);
  }
  if (planId != null && typeof planId !== 'string') {
    return fail(INVALID, '`planId` must be a string.', 400);
  }
  if (model != null && typeof model !== 'string') {
    return fail(INVALID, '`model` must be a string.', 400);
  }

  try {
    const renewed = await aiGenerationService.renewRevisionLeaseForJob(
      {
        jobId,
        planId: (planId as string | undefined) ?? null,
        model: (model as string | undefined) ?? null,
      },
      auth,
    );
    return NextResponse.json(renewed);
  } catch (err) {
    if (err instanceof NoPlanForJobError || err instanceof PlanNotFoundError) {
      return fail(err.code, err.message, 404);
    }
    if (err instanceof ProjectAccessDeniedError) {
      return fail(err.code, err.message, err.kind === 'browse' ? 404 : 403);
    }
    throw err;
  }
}
