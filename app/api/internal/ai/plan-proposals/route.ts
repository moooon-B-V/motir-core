import { NextResponse } from 'next/server';
import { authenticateJobRequest, JobAuthError } from '@/lib/ai/jobAuth';
import { aiGenerationService } from '@/lib/services/aiGenerationService';
import {
  InvalidProposalError,
  NoPlanForJobError,
  PlanNotFoundError,
  PlanNotGeneratingError,
  PlanNotInExpectedStatusError,
} from '@/lib/plans/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import type { ProposalInput } from '@/lib/dto/plans';

// POST /api/internal/ai/plan-proposals (Subtask 7.4.4 · MOTIR-846) — the INTERNAL
// append seam motir-ai's `generate_tree` handler (7.4.2 · MOTIR-844) calls,
// REPLACING the whole-delta `plan-delta`. It appends a batch of `add` PlanItems to
// the job's `Plan` via the 7.21 `plansService.addProposals` (resolved from the
// job token's `sourceJobId`), as the token's user — creating NO WorkItem and
// setting no status (proposals are `PlanItem` rows). It returns the created
// PlanItem ids IN APPEND ORDER (the stable temp-ref keys the handler reuses for
// intra-plan parent/blocker refs). `final: true` marks the plan `planned` on
// frontier completion (a flag on this route, not a second endpoint).
//
// Service-to-service only (§4a service bearer + §4b job token, via
// authenticateJobRequest). Thin transport: authenticate, parse, ONE service call,
// map errors. Grammar/ref validation lives in the 7.21 service, not re-here.
//
// Typed errors → status:
//   JobAuthError                  → 401 (bad service bearer / missing-expired token)
//   NoPlanForJobError / PlanNotFoundError → 404 (no plan for this job in the
//                                          token's tenant — cross-tenant 404-not-403)
//   PlanNotGeneratingError /
//     PlanNotInExpectedStatusError → 409 (the plan already left `generating`)
//   InvalidProposalError          → 422 (a proposal inconsistent with its op)
//   ProjectAccessDeniedError      → 404 browse / 403 edit
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
      { code: 'PROPOSALS_INVALID', error: 'request body must be valid JSON' },
      { status: 400 },
    );
  }

  const jobId = (body as { jobId?: unknown })?.jobId;
  if (typeof jobId !== 'string' || !jobId) {
    return NextResponse.json(
      { code: 'PROPOSALS_INVALID', error: '`jobId` is required.' },
      { status: 400 },
    );
  }
  const rawProposals = (body as { proposals?: unknown })?.proposals ?? [];
  if (!Array.isArray(rawProposals)) {
    return NextResponse.json(
      { code: 'PROPOSALS_INVALID', error: '`proposals` must be an array.' },
      { status: 400 },
    );
  }
  const final = (body as { final?: unknown })?.final === true;

  try {
    const result = await aiGenerationService.appendProposals(
      jobId,
      rawProposals as ProposalInput[],
      auth.ctx,
      { final },
    );
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof NoPlanForJobError || err instanceof PlanNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof PlanNotGeneratingError || err instanceof PlanNotInExpectedStatusError) {
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
