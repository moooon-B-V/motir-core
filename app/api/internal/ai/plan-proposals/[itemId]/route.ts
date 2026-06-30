import { NextResponse } from 'next/server';
import { authenticateJobRequest, JobAuthError } from '@/lib/ai/jobAuth';
import { aiGenerationService } from '@/lib/services/aiGenerationService';
import {
  InvalidProposalError,
  NoPlanForJobError,
  PlanItemNotFoundError,
  PlanNotFoundError,
  PlanNotGeneratingError,
  PlanNotInExpectedStatusError,
} from '@/lib/plans/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import type { UpdateProposalInput } from '@/lib/dto/plans';

// PATCH /api/internal/ai/plan-proposals/[itemId] (Subtask 7.4.4a · MOTIR-1441) —
// the INTERNAL generation-time DEEPEN seam motir-ai's `generate_tree` handler
// (7.4.2 · MOTIR-844) calls in Phase 2 of the titles-first strategy: after the
// title+edge SKELETON is appended (POST .../plan-proposals), each `add`
// proposal's `descriptionMd` (+ finalised type/priority/storyPoints/
// estimateMinutes) is PATCHED one at a time WHILE the Plan is still
// `generating`. The Plan is resolved from the job token's `sourceJobId` (the
// `jobId` in the body), acting as the token's user. Creates NO WorkItem; the
// plan stays `generating` until a later `final:true` append marks it `planned`.
//
// This is the generation-time twin of the user-facing `PATCH /api/plans/[id]/
// items/[itemId]` (7.21.6 · MOTIR-1370): the public route edits a `planned`
// plan from a cookie session; THIS route deepens a `generating` plan from a job
// token. Same merge/validate substrate (`plansService` editAddProposal); the
// status gate (`generating`) and the auth surface (job token) are the only
// differences.
//
// Service-to-service only (§4a service bearer + §4b job token, via
// authenticateJobRequest). Thin transport: authenticate, parse, ONE service
// call, map errors. Merge/validation lives in the 7.21 service, not re-here.
//
// Typed errors → status:
//   JobAuthError                          → 401 (bad service bearer / missing-expired token)
//   NoPlanForJobError / PlanNotFoundError /
//     PlanItemNotFoundError               → 404 (no plan/item for this job in the token's tenant)
//   PlanNotInExpectedStatusError /
//     PlanNotGeneratingError              → 409 (the plan already left `generating`)
//   InvalidProposalError                  → 422 (empty title / editing a non-`add` / bad sizing)
//   ProjectAccessDeniedError              → 404 browse / 403 edit
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ itemId: string }> },
): Promise<Response> {
  let auth;
  try {
    auth = authenticateJobRequest(req);
  } catch (err) {
    if (err instanceof JobAuthError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: err.httpStatus });
    }
    throw err;
  }

  const { itemId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'PROPOSALS_INVALID', error: 'request body must be valid JSON' },
      { status: 400 },
    );
  }
  if (typeof body !== 'object' || body === null) {
    return NextResponse.json(
      { code: 'PROPOSALS_INVALID', error: 'request body must be a JSON object' },
      { status: 400 },
    );
  }
  const b = body as Record<string, unknown>;
  const jobId = b.jobId;
  if (typeof jobId !== 'string' || !jobId) {
    return NextResponse.json(
      { code: 'PROPOSALS_INVALID', error: '`jobId` is required.' },
      { status: 400 },
    );
  }

  // The editable fields ride under `patch`. Pick ONLY the editable keys (sparse
  // merge in the service: an absent key is left untouched, an explicit `null` on
  // a nullable field clears it). This mirrors the public PATCH route's parsing
  // exactly, so both edit paths accept the same shape; a present-but-non-number
  // size (other than the explicit clear) becomes `null` and the service
  // re-validates the merged values.
  const patch = (typeof b.patch === 'object' && b.patch !== null ? b.patch : {}) as Record<
    string,
    unknown
  >;
  const input: UpdateProposalInput = {
    ...(typeof patch.title === 'string' ? { title: patch.title } : {}),
    ...(typeof patch.kind === 'string' ? { kind: patch.kind } : {}),
    ...('descriptionMd' in patch
      ? { descriptionMd: typeof patch.descriptionMd === 'string' ? patch.descriptionMd : null }
      : {}),
    ...('type' in patch ? { type: typeof patch.type === 'string' ? patch.type : null } : {}),
    ...('priority' in patch
      ? { priority: typeof patch.priority === 'string' ? patch.priority : null }
      : {}),
    ...('storyPoints' in patch
      ? { storyPoints: typeof patch.storyPoints === 'number' ? patch.storyPoints : null }
      : {}),
    ...('estimateMinutes' in patch
      ? {
          estimateMinutes: typeof patch.estimateMinutes === 'number' ? patch.estimateMinutes : null,
        }
      : {}),
  };

  try {
    const result = await aiGenerationService.patchProposal(jobId, itemId, input, auth.ctx);
    return NextResponse.json(result);
  } catch (err) {
    if (
      err instanceof NoPlanForJobError ||
      err instanceof PlanNotFoundError ||
      err instanceof PlanItemNotFoundError
    ) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof PlanNotInExpectedStatusError || err instanceof PlanNotGeneratingError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
    }
    if (err instanceof InvalidProposalError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
    }
    if (err instanceof ProjectAccessDeniedError) {
      return NextResponse.json(
        { code: err.code, error: err.message },
        { status: err.kind === 'browse' ? 404 : 403 },
      );
    }
    throw err;
  }
}
