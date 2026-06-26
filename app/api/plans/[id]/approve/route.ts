import { NextResponse } from 'next/server';

import { getWorkspaceContext } from '@/lib/workspaces';
import { plansService } from '@/lib/services/plansService';
import { PlanNotFoundError, PlanNotInExpectedStatusError } from '@/lib/plans/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';

// POST /api/plans/[id]/approve — APPROVE = materialize (Subtask 7.4.5 / MOTIR-847,
// calling the MOTIR-1336 substrate). Adds become real work items, modifies apply
// to the same id (one logged revision), removes archive. The service is the atomic
// one-shot guard: a second concurrent approve observes `approved` and 409s.
//
// HTTP only (CLAUDE.md 4-layer): resolve the workspace, call ONE service method,
// map typed errors. `approvePlan` asserts `canEdit` (→ 403/404).
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id } = await params;
  try {
    const plan = await plansService.approvePlan(id, ctx);
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
