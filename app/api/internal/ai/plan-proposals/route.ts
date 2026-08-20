import { NextResponse } from 'next/server';
import { authenticateAndLimitJobRequest } from '@/lib/ai/jobAuth';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import { aiGenerationService } from '@/lib/services/aiGenerationService';
import {
  DuplicatePlanTargetError,
  InvalidProposalError,
  NoPlanForJobError,
  PlanItemUnknownTargetRepoRoleError,
  PlanNotFoundError,
  PlanNotGeneratingError,
  PlanNotInExpectedStatusError,
  PlanPersistenceError,
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
//   DuplicatePlanTargetError      → 409 (this plan already proposes against that
//                                          work item — MOTIR-3194)
//   InvalidProposalError          → 422 (a proposal inconsistent with its op)
//   PlanPersistenceError          → 500 (an ORM failure inside the append,
//                                          CONTAINED — a typed code and a sentence
//                                          instead of Prisma's own prose)
//   PlanItemUnknownTargetRepoRoleError → 422 (a `targetRepoRole` outside the
//                                          shared role vocabulary — MOTIR-1912)
//   ProjectAccessDeniedError      → 404 browse / 403 edit
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
  // The AI-suggested project name (MOTIR-1554/1551) rides ONLY the final append,
  // and only from the onboarding generation. Accept a string; anything else
  // (absent/null/non-string) is "no name" — the consumer keeps the placeholder.
  const rawProductName = (body as { productName?: unknown })?.productName;
  const productName = typeof rawProductName === 'string' ? rawProductName : null;

  try {
    const result = await aiGenerationService.appendProposals(
      jobId,
      rawProposals as ProposalInput[],
      auth.ctx,
      { final, productName },
    );
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof NoPlanForJobError || err instanceof PlanNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof PlanNotGeneratingError || err instanceof PlanNotInExpectedStatusError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
    }
    // A second `modify`/`remove` for a work item this plan already targets
    // (MOTIR-3194). 409 rather than 422: the batch is well-formed, and what it
    // conflicts with is the plan's existing CONTENT. `workItem` rides as data so
    // the generator can act on it without parsing the sentence.
    if (err instanceof DuplicatePlanTargetError) {
      return NextResponse.json(
        { code: err.code, workItem: err.workItemId, error: err.message },
        { status: 409 },
      );
    }
    if (err instanceof InvalidProposalError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
    }
    // A proposal pinning a repo ROLE outside the vocabulary the two repos share
    // (MOTIR-1912). Rejected at the APPEND rather than at approve, so the producer
    // learns while it is still writing the plan; `proposal` names which one.
    if (err instanceof PlanItemUnknownTargetRepoRoleError) {
      return NextResponse.json(
        { code: err.code, proposal: err.proposalLabel, role: err.role, error: err.message },
        { status: 422 },
      );
    }
    if (err instanceof ProjectAccessDeniedError) {
      return NextResponse.json(
        { code: err.code, error: err.message },
        { status: err.kind === 'browse' ? 404 : 403 },
      );
    }
    // An ORM failure inside the append, contained by the service (MOTIR-3194).
    // It IS a 500 — nothing about the request could have avoided it — but it is a
    // 500 with a stable code, so the generator's retry logic reads a contract
    // rather than a Prisma invocation trace. `ormCode` rides as data.
    if (err instanceof PlanPersistenceError) {
      return NextResponse.json(
        { code: err.code, ormCode: err.ormCode, error: err.message },
        { status: 500 },
      );
    }
    throw err;
  }
}
