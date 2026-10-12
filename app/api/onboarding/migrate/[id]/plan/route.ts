import { NextResponse } from 'next/server';

import { migrateOnboardingService } from '@/lib/services/migrateOnboardingService';
import { mapMigrateError } from '../../_errors';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// GET /api/onboarding/migrate/[id]/plan — the plan this run's generate step
// drafted (MOTIR-8254 · design/onboarding-migrate § Revision 6, Panel 6c). The
// wizard's "A few questions" step reads it once the run reaches `review`, to
// show the drafted count and open the plan's review. Browse-gated; `no-store`
// so the count is never a stale cache.
//
// HTTP only (CLAUDE.md 4-layer): resolve the workspace, call ONE service method,
// map typed errors.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { id } = await params;
  try {
    const plan = await migrateOnboardingService.getGeneratedPlan(id, ctx);
    return NextResponse.json(plan, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapMigrateError(err);
    if (mapped) return mapped;
    throw err;
  }
}
