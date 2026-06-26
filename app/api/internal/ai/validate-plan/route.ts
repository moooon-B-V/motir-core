import { NextResponse } from 'next/server';
import { authenticateJobRequest, JobAuthError } from '@/lib/ai/jobAuth';
import { planValidityService } from '@/lib/services/planValidityService';
import { PlanNotFoundError } from '@/lib/plans/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ValidityCondition } from '@/lib/dto/sprints';

// POST /api/internal/ai/validate-plan (Subtask 7.28.2) — the WORK-ITEM analogue
// pre-commit finishability check. Body `{ planId, targetKey, condition? }` →
// `planValidityService.validateProjectedWorkItem` → the `{ key, valid, blockers }`
// validity DTO. Read-only, server-to-server only (§4a service bearer + §4b
// job-scoped token, via authenticateJobRequest) — never reachable from the
// browser and NEVER touches the write path. Thin transport, mirroring
// `plan-delta`: authenticate, parse, ONE service call, map typed errors.
//
// Typed errors → status:
//   JobAuthError              → 401
//   (bad/missing body, unknown condition) → 400
//   PlanNotFoundError         → 404
//   ProjectNotFoundError      → 404
//   ProjectAccessDeniedError  → 404 (no existence leak)
//   WorkItemNotFoundError     → 404 (unknown targetKey)
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
      { code: 'VALIDATE_PLAN_INVALID', error: 'request body must be valid JSON' },
      { status: 400 },
    );
  }

  if (typeof body !== 'object' || body === null) {
    return NextResponse.json(
      { code: 'VALIDATE_PLAN_INVALID', error: 'request body must be an object' },
      { status: 400 },
    );
  }
  const { planId, targetKey, condition } = body as Record<string, unknown>;
  if (typeof planId !== 'string' || planId.length === 0) {
    return NextResponse.json(
      { code: 'VALIDATE_PLAN_INVALID', error: 'planId is required' },
      { status: 400 },
    );
  }
  if (typeof targetKey !== 'string' || targetKey.length === 0) {
    return NextResponse.json(
      { code: 'VALIDATE_PLAN_INVALID', error: 'targetKey is required' },
      { status: 400 },
    );
  }
  if (condition !== undefined && condition !== 'loose' && condition !== 'tight') {
    return NextResponse.json(
      { code: 'VALIDATE_PLAN_INVALID', error: "condition must be 'loose' or 'tight'" },
      { status: 400 },
    );
  }

  try {
    const result = await planValidityService.validateProjectedWorkItem(
      planId,
      targetKey,
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
    if (err instanceof WorkItemNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
