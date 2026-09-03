import { NextResponse } from 'next/server';
import { authenticateAndLimitJobRequest } from '@/lib/ai/jobAuth';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import { aiWorkItemsService } from '@/lib/services/aiWorkItemsService';
import { NoPlanForJobError, PlannerBugCapExceededError } from '@/lib/plans/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import {
  CrossProjectParentError,
  DepthLimitExceededError,
  IllegalParentTypeError,
  ParentCycleError,
  WorkItemNotFoundError,
} from '@/lib/workItems/errors';

// POST /api/internal/ai/log-bug (Story MOTIR-4053 · Subtask MOTIR-4076) — the
// PLANNER's `log_bug` sink: file ONE `kind: bug` into the JOB'S OWN project,
// authenticated by the JOB TOKEN, as the token's user. The first non-proposal a
// planning run writes into a customer's tenant; whether it may, and under what
// bound, is `motir-ai/docs/decisions/planner-files-tenant-bug.md`.
//
// ⚠️ NOT the system-principal route. `POST /api/internal/ai/work-items`
// (MOTIR-1450) authenticates with the service bearer ALONE, acts as the Motir
// SYSTEM principal and resolves `projectKey` only inside Motir's own workspace —
// it files planner-mistake bugs into MOTIR/PROD and is structurally unable to
// reach a customer project (MOTIR-1460 finding 1). This route is the OTHER
// direction: the customer's own defect, into the customer's own tree. Giving
// one endpoint two authorities and two destinations is what this file exists
// to avoid, so the two stay separate.
//
// Auth: §4a service bearer + §4b job token (`authenticateAndLimitJobRequest`),
// exactly as the append seam `plan-proposals`. ⚠️ THE PROJECT IS THE TOKEN'S —
// the body carries NO project argument at all, so a foreign project is
// unexpressible rather than refused; the job's plan must sit in that project
// or the job resolves to no plan (404, the no-leak posture).
//
// Thin transport (the 4-layer rule): authenticate → validate the body → ONE
// service call (`aiWorkItemsService.filePlannerBug`) → map typed errors. The
// bound (kind / project / volume / record) is enforced IN the service, under the
// plan's row lock — never here, and never only in motir-ai's tool.
//
// Typed errors → status (the family's `{ code, error }` shape):
//   JobAuthError                    → 401 (bad service bearer / missing-expired token)
//   LOG_BUG_INVALID                 → 400 (body shape)
//   NoPlanForJobError               → 404 (no plan for this job IN THE TOKEN'S PROJECT
//                                          and tenant — cross-tenant 404-not-403)
//   WorkItemNotFoundError /
//     ProjectNotFoundError          → 404 (a `parentKey` outside the token's project)
//   ProjectAccessDeniedError        → 404 browse / 403 edit
//   PlannerBugCapExceededError      → 409 (the VOLUME bound — `cap` + `filed` ride as data)
//   IllegalParentTypeError / CrossProjectParentError /
//     DepthLimitExceededError / ParentCycleError → 422 (a parent the matrix forbids)

function fail(code: string, error: string, status: number): NextResponse {
  return NextResponse.json({ code, error }, { status });
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
    return fail('LOG_BUG_INVALID', 'request body must be valid JSON', 400);
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const { jobId, title, descriptionMd, parentKey, model } = b;

  if (typeof jobId !== 'string' || jobId.trim() === '') {
    return fail('LOG_BUG_INVALID', '`jobId` is required.', 400);
  }
  if (typeof title !== 'string' || title.trim() === '') {
    return fail('LOG_BUG_INVALID', '`title` is required.', 400);
  }
  if (descriptionMd != null && typeof descriptionMd !== 'string') {
    return fail('LOG_BUG_INVALID', '`descriptionMd` must be a string.', 400);
  }
  if (parentKey != null && typeof parentKey !== 'string') {
    return fail('LOG_BUG_INVALID', '`parentKey` must be a string.', 400);
  }
  if (model != null && typeof model !== 'string') {
    return fail('LOG_BUG_INVALID', '`model` must be a string.', 400);
  }

  try {
    const filed = await aiWorkItemsService.filePlannerBug(
      {
        jobId,
        title: title.trim(),
        descriptionMd: descriptionMd ?? null,
        parentKey: parentKey ?? null,
        model: model ?? null,
      },
      auth,
    );
    return NextResponse.json(filed, { status: 201 });
  } catch (err) {
    if (err instanceof NoPlanForJobError) return fail(err.code, err.message, 404);
    if (err instanceof WorkItemNotFoundError || err instanceof ProjectNotFoundError) {
      return fail(err.code, err.message, 404);
    }
    if (err instanceof ProjectAccessDeniedError) {
      return fail(err.code, err.message, err.kind === 'browse' ? 404 : 403);
    }
    // The VOLUME bound (ADR §3). 409, not 422: the request is well-formed, and
    // what it conflicts with is the plan trail's existing content. The numbers
    // ride as data so the tool can tell the model WHICH bound it hit.
    if (err instanceof PlannerBugCapExceededError) {
      return NextResponse.json(
        { code: err.code, cap: err.cap, filed: err.filed, error: err.message },
        { status: 409 },
      );
    }
    if (
      err instanceof IllegalParentTypeError ||
      err instanceof CrossProjectParentError ||
      err instanceof DepthLimitExceededError ||
      err instanceof ParentCycleError
    ) {
      return fail(err.code, err.message, 422);
    }
    throw err;
  }
}
