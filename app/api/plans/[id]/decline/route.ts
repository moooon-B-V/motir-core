import { NextResponse } from 'next/server';

import { getWorkspaceContext } from '@/lib/workspaces';
import { plansService } from '@/lib/services/plansService';
import { PlanNotFoundError, PlanNotInExpectedStatusError } from '@/lib/plans/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';

// POST /api/plans/[id]/decline — DECLINE = drop the proposals (Subtask 7.4.5 /
// MOTIR-847, calling the MOTIR-1336 substrate). The PlanItems are deleted; the
// work-item tree is NEVER touched (adds never materialized; modify/remove targets
// untouched). Status → `declined`.
//
// HTTP only (CLAUDE.md 4-layer): resolve the workspace, call ONE service method,
// map typed errors. `declinePlan` asserts `canEdit` (→ 403/404).
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id } = await params;
  try {
    const plan = await plansService.declinePlan(id, ctx);
    return NextResponse.json(plan);
  } catch (err) {
    if (err instanceof PlanNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof PlanNotInExpectedStatusError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
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
