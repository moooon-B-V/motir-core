import { NextResponse } from 'next/server';
import { plansService } from '@/lib/services/plansService';
import { InvalidPlanHistoryCursorError } from '@/lib/plans/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { workItemGateErrorResponse } from '@/lib/workItems/gateResponse';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// GET /api/work-items/[id]/plans (Story MOTIR-5542 · MOTIR-5546) — one page of
// the work item's PLAN HISTORY: every plan that created, changed, archived or
// added children under it, in any status, oldest first, one entry per plan.
// `?cursor=` continues from a previous page's `nextCursor`; `?limit=` is clamped
// by the service. The item page's "show all" reads this. READ-ONLY. Thin HTTP
// layer over `plansService.listPlanHistoryByWorkItemId`; no db here (CLAUDE.md).
//
// Typed errors → status codes:
//   WorkItemNotFoundError / ProjectNotFoundError → 404 (unknown, cross-workspace,
//                                   or a project the actor cannot browse — no leak)
//   PermissionDeniedError (`ai:view_plan`) → 403
//   InvalidPlanHistoryCursorError         → 400
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { id } = await params;
  const url = new URL(req.url);
  const cursor = url.searchParams.get('cursor');
  const limitParam = url.searchParams.get('limit');
  // A non-numeric limit is not refused: the service clamps, and NaN clamps to
  // the default page size.
  const limit = limitParam === null ? undefined : Number(limitParam);

  try {
    const page = await plansService.listPlanHistoryByWorkItemId(id, { cursor, limit }, ctx);
    return NextResponse.json(page);
  } catch (err) {
    const gateResponse = workItemGateErrorResponse(err);
    if (gateResponse) return gateResponse;
    if (err instanceof WorkItemNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof InvalidPlanHistoryCursorError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
    }
    throw err;
  }
}
