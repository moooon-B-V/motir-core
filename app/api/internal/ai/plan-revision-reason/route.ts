import { NextResponse } from 'next/server';
import { authenticateAndLimitJobRequest } from '@/lib/ai/jobAuth';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import { aiGenerationService } from '@/lib/services/aiGenerationService';
import {
  NoPlanForJobError,
  PlanNotEditableError,
  PlanNotFoundError,
  PlanRevisionClassificationInvalidError,
} from '@/lib/plans/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { REVISION_REASON_BRANCHES, isRevisionReasonBranch } from '@/lib/plans/revisionReason';

// POST /api/internal/ai/plan-revision-reason (Story MOTIR-5543 · Subtask
// MOTIR-6087) — the SHIPPED PLANNER's door onto the internal classification
// record. motir-ai's REVISE_PLAN pass calls it BEFORE it corrects anything, to
// say WHY the plan had to change.
//
// Four branches, and only two of them are about the planner: `new_ask` and
// `different_solution` file nothing, `rule_gap` and `rule_not_followed` each
// carry the id of the one planning bug they filed. The row is written on ALL
// four, including the two that file nothing — a silent "no bug" cannot be told
// from a forgotten one, and that is the whole reason this door exists rather
// than the pass simply filing fewer bugs.
//
// ⚠️ NOTHING HERE IS TENANT-FACING. The row's kind is internal, and every
// tenant read excludes it at the query (`planRevisionRepository`'s
// `TENANT_VISIBLE_PLAN_REVISION_WHERE`). This route writes it; no route reads
// it back. Epic 10 is the eventual reader.
//
// Auth: §4a service bearer + §4b job token (`authenticateAndLimitJobRequest`),
// exactly as `plan-proposals` and `log-bug`.
//
// ⚠️ THE PLAN IS THE JOB'S. `planId` is accepted and CROSS-CHECKED, never used
// as the address: this family resolves the job's plan from `sourceJobId` (the
// service's own header — *"no planId threading through motir-ai"*), and
// `log-bug` states the posture that goes with it — a foreign plan should be
// unexpressible rather than refused. A mismatched `planId` gets the same 404 a
// foreign job gets, so a caller that guessed one learns nothing.
//
// Thin transport (the 4-layer rule): authenticate → validate the body → ONE
// service call → map typed errors. Every rule about what may be recorded lives
// in `plansService.recordRevisionClassification`, under the plan's row lock.
//
// Typed errors → status (the family's `{ code, error }` shape):
//   JobAuthError                           → 401 (bad service bearer / missing-expired token)
//   PLAN_REVISION_REASON_INVALID           → 400 (body shape)
//   NoPlanForJobError / PlanNotFoundError  → 404 (no plan for this job in the token's
//                                                 project and tenant — cross-tenant
//                                                 404-not-403, and a mismatched planId)
//   PlanNotEditableError                   → 409 (the plan is approved or declined —
//                                                 a decided plan cannot be reclassified)
//   PlanRevisionClassificationInvalidError → 422 (a branch / bug pairing that
//                                                 contradicts itself, or evidence
//                                                 missing or past its bound)
//   ProjectAccessDeniedError               → 404 browse / 403 edit

function fail(code: string, error: string, status: number): NextResponse {
  return NextResponse.json({ code, error }, { status });
}

const INVALID = 'PLAN_REVISION_REASON_INVALID';

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
  const { jobId, planId, branch, evidenceMd, planningBugId, model } = b;

  if (typeof jobId !== 'string' || jobId.trim() === '') {
    return fail(INVALID, '`jobId` is required.', 400);
  }
  if (planId != null && typeof planId !== 'string') {
    return fail(INVALID, '`planId` must be a string.', 400);
  }
  // The branch is checked HERE as well as in the service, and that is not a
  // duplicated rule: a value outside the vocabulary is a malformed REQUEST (400)
  // rather than a classification that contradicts itself (422), and the two
  // answer different questions for the caller's retry logic. The names ride in
  // the message so the pass can correct itself without reading this file.
  if (!isRevisionReasonBranch(branch)) {
    return fail(INVALID, `\`branch\` must be one of: ${REVISION_REASON_BRANCHES.join(', ')}.`, 400);
  }
  if (typeof evidenceMd !== 'string' || evidenceMd.trim() === '') {
    return fail(INVALID, '`evidenceMd` is required.', 400);
  }
  if (planningBugId != null && typeof planningBugId !== 'string') {
    return fail(INVALID, '`planningBugId` must be a string.', 400);
  }
  if (model != null && typeof model !== 'string') {
    return fail(INVALID, '`model` must be a string.', 400);
  }

  try {
    const recorded = await aiGenerationService.recordRevisionReason(
      {
        jobId,
        planId: (planId as string | undefined) ?? null,
        branch,
        evidenceMd,
        planningBugId: (planningBugId as string | undefined) ?? null,
        model: (model as string | undefined) ?? null,
      },
      auth,
    );
    return NextResponse.json(recorded, { status: 201 });
  } catch (err) {
    if (err instanceof NoPlanForJobError || err instanceof PlanNotFoundError) {
      return fail(err.code, err.message, 404);
    }
    // A decided plan. 409, not 422: the request is well-formed, and what it
    // conflicts with is the plan's own state.
    if (err instanceof PlanNotEditableError) {
      return fail(err.code, err.message, 409);
    }
    // The branch / bug pairing, the bug's identity and project, and the evidence
    // bound. 422: the request is understood and refused on its content. The
    // BRANCH rides as data so the pass can tell which of its four it got wrong
    // without parsing the sentence.
    if (err instanceof PlanRevisionClassificationInvalidError) {
      return NextResponse.json(
        { code: err.code, branch: err.branch, error: err.message },
        { status: 422 },
      );
    }
    if (err instanceof ProjectAccessDeniedError) {
      return fail(err.code, err.message, err.kind === 'browse' ? 404 : 403);
    }
    throw err;
  }
}
