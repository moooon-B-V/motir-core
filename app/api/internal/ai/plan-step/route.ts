import { NextResponse } from 'next/server';
import { authenticateAndLimitJobRequest } from '@/lib/ai/jobAuth';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import { aiPlanGateErrorResponse } from '@/lib/ai/planGateResponse';
import { aiGenerationService } from '@/lib/services/aiGenerationService';
import {
  InvalidPlanStepError,
  NoPlanForJobError,
  PlanNotFoundError,
  PlanNotGeneratingError,
} from '@/lib/plans/errors';

// POST /api/internal/ai/plan-step (Story MOTIR-7820 · Subtask MOTIR-7824) — the
// HOSTED planner's door onto the plan's in-flight STEPS: motir-ai's walk reports
// the step each of its sessions opens (`settle`, `lay`, `author`) and clears it
// with `end`, so a person following the plan sees what is being drafted now.
// `report_plan_step` is the MCP twin, with the same four values.
//
// Auth: §4a service bearer + §4b job token (`authenticateAndLimitJobRequest`),
// exactly as `plan-proposals` and `plan-revision-reason`.
//
// ⚠️ THE PLAN IS THE JOB'S. `planId` is accepted and CROSS-CHECKED, never used
// as the address, and a mismatch gets the same 404 a foreign job gets.
//
// ⚠️ `target` IS OPTIONAL ON EVERY STEP HERE. Whether a step may carry one — and
// the two untargeted forms a walk really has, the project-level lay and the
// no-id create — is the step store's rule, and a refusal of it comes back as its
// 422. Checking "target required" here would be a second copy of that rule, and
// the copy that refuses real steps.
//
// The signal is ADVISORY, so every refusal is a stable `{ code, error }` and
// never a 500: the walk matches the code and carries on.
//
// Typed errors → status:
//   JobAuthError                          → 401 (bad service bearer / missing-expired token)
//   PLAN_STEP_INVALID (body shape)        → 400
//   NoPlanForJobError / PlanNotFoundError → 404 (no plan for this job in the token's
//                                                project and tenant, or a mismatched planId)
//   PlanNotGeneratingError                → 409 (the plan is not being written any more)
//   InvalidPlanStepError                  → 422 (a target the step may not carry, or a
//                                                ref naming nothing on this plan)
//   the plan gate's refusals              → `aiPlanGateErrorResponse`, as `plan-proposals`

function fail(code: string, error: string, status: number): NextResponse {
  return NextResponse.json({ code, error }, { status });
}

const INVALID = 'PLAN_STEP_INVALID';
const STEPS = ['settle', 'lay', 'author', 'end'] as const;
type Step = (typeof STEPS)[number];

function isStep(v: unknown): v is Step {
  return typeof v === 'string' && (STEPS as readonly string[]).includes(v);
}

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
  const b = (body ?? {}) as Record<string, unknown>;
  const { jobId, planId, sessionKey, step, target } = b;

  if (typeof jobId !== 'string' || jobId.trim() === '') {
    return fail(INVALID, '`jobId` is required.', 400);
  }
  if (planId != null && typeof planId !== 'string') {
    return fail(INVALID, '`planId` must be a string.', 400);
  }
  if (typeof sessionKey !== 'string') {
    return fail(INVALID, '`sessionKey` is required and must be a string.', 400);
  }
  if (!isStep(step)) {
    return fail(INVALID, `\`step\` must be one of: ${STEPS.join(', ')}.`, 400);
  }
  if (target != null && typeof target !== 'string') {
    return fail(INVALID, '`target` must be a string.', 400);
  }

  try {
    const result = await aiGenerationService.recordPlanStepForJob(
      {
        jobId,
        planId: (planId as string | undefined) ?? null,
        sessionKey,
        step,
        targetRef: (target as string | undefined) ?? null,
      },
      auth,
    );
    return NextResponse.json(result);
  } catch (err) {
    const gate = aiPlanGateErrorResponse(err);
    if (gate) return gate;
    if (err instanceof NoPlanForJobError || err instanceof PlanNotFoundError) {
      return fail(err.code, err.message, 404);
    }
    if (err instanceof PlanNotGeneratingError) {
      return fail(err.code, err.message, 409);
    }
    if (err instanceof InvalidPlanStepError) {
      return fail(err.code, err.message, 422);
    }
    throw err;
  }
}
