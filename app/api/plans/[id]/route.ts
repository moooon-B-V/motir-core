import { NextResponse } from 'next/server';

import { getWorkspaceContext } from '@/lib/workspaces';
import { planReviewService } from '@/lib/services/planReviewService';
import { PlanNotFoundError } from '@/lib/plans/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';

// GET /api/plans/[id] — the plan-detail REVIEW model (Subtask 7.4.5 / MOTIR-847):
// the plan + its proposed items (op-enriched with live targets), per-item
// staleness, history, and the decider name. The plan-detail page reads it once
// server-side; the client POLLS it while the plan is `generating` for the "live"
// per-level reveal — reading the SUBSTRATE's own data, never the 7.4 stream.
//
// HTTP only (CLAUDE.md 4-layer): resolve the workspace, call ONE service method,
// map typed errors. A plan the actor can't browse is hidden as a 404 (the
// no-existence-leak rule the access gate already encodes for `browse`).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

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
