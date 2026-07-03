import { NextResponse } from 'next/server';
import { authenticateJobRequest, JobAuthError } from '@/lib/ai/jobAuth';
import { planValidityService } from '@/lib/services/planValidityService';
import { PlanNotFoundError } from '@/lib/plans/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import type { ValidityCondition } from '@/lib/dto/sprints';

// POST /api/internal/ai/validate-plan-forest (MOTIR-1550) — the WHOLE-PLAN
// (forest) analogue of the pre-commit finishability check. Body
// `{ planId, condition? }` (NO targetKey — it validates the ENTIRE projected
// forest, not one subtree) → `planValidityService.validateProjectedPlan` → the
// `{ planId, valid, blockers }` validity DTO. This is the entry the `generate_tree`
// /replan worker (MOTIR-1398) runs as its pre-commit post-condition over the
// multi-root epic forest it proposes: a cross-root `blocked_by` edge (a story
// under epic B gated by a story under epic A) is VALID here, whereas iterating
// the single-target `validate-plan` per root would false-positive it.
//
// Read-only, server-to-server only (§4a service bearer + §4b job-scoped token,
// via authenticateJobRequest) — never reachable from the browser and NEVER
// touches the write path. Thin transport, mirroring `validate-plan-sprint`:
// authenticate, parse, ONE service call, map typed errors.
//
// Typed errors → status:
//   JobAuthError              → 401
//   (bad/missing body, unknown condition) → 400
//   PlanNotFoundError         → 404
//   ProjectNotFoundError      → 404
//   ProjectAccessDeniedError  → 404 (no existence leak)
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
      { code: 'VALIDATE_PLAN_FOREST_INVALID', error: 'request body must be valid JSON' },
      { status: 400 },
    );
  }

  if (typeof body !== 'object' || body === null) {
    return NextResponse.json(
      { code: 'VALIDATE_PLAN_FOREST_INVALID', error: 'request body must be an object' },
      { status: 400 },
    );
  }
  const { planId, condition } = body as Record<string, unknown>;
  if (typeof planId !== 'string' || planId.length === 0) {
    return NextResponse.json(
      { code: 'VALIDATE_PLAN_FOREST_INVALID', error: 'planId is required' },
      { status: 400 },
    );
  }
  if (condition !== undefined && condition !== 'loose' && condition !== 'tight') {
    return NextResponse.json(
      { code: 'VALIDATE_PLAN_FOREST_INVALID', error: "condition must be 'loose' or 'tight'" },
      { status: 400 },
    );
  }

  try {
    const result = await planValidityService.validateProjectedPlan(
      planId,
      auth.ctx,
      condition as ValidityCondition | undefined,
    );
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof PlanNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof ProjectNotFoundError || err instanceof ProjectAccessDeniedError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
