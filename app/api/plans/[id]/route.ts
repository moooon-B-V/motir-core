import { NextResponse } from 'next/server';
import { memberThenVisitor } from '@/lib/visitor/readActor';
import type { VisitorReadContext } from '@/lib/visitor/context';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

import { planReviewService } from '@/lib/services/planReviewService';
import { PlanNotFoundError } from '@/lib/plans/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// GET /api/plans/[id] — the plan-detail REVIEW model (Subtask 7.4.5 / MOTIR-847):
// the plan + its proposed items (op-enriched with live targets), per-item
// staleness, history, and the decider name. The plan-detail page reads it once
// server-side; the client POLLS it while the plan is `generating` for the "live"
// per-level reveal — reading the SUBSTRATE's own data, never the 7.4 stream.
//
// HTTP only (CLAUDE.md 4-layer): resolve the workspace, call ONE service method,
// map typed errors. A plan the actor can't browse is hidden as a 404 (the
// no-existence-leak rule the access gate already encodes for `browse`).
/** The read itself, for a member's context or a Visitor's (MOTIR-6647). */
async function serve(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
  ctx: ServiceContext | VisitorReadContext,
): Promise<Response> {
  const { id } = await params;
  try {
    const review = await planReviewService.getPlanReview(id, ctx);
    return NextResponse.json(review);
  } catch (err) {
    if (err instanceof PlanNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
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

async function memberGET(
  req: Request,
  route: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  return serve(req, route, ctx);
}

/**
 * One plan's review — members exactly as before; a VISITOR (MOTIR-6647) of the
 * plan's public project reads it only when the plan touches no private-epic
 * descendant (MOTIR-6645), and only when the member read found nothing for them.
 */
export async function GET(
  req: Request,
  route: { params: Promise<{ id: string }> },
): Promise<Response> {
  return memberThenVisitor(
    req,
    () => memberGET(req, route),
    (ctx) => serve(req, route, ctx),
  );
}
