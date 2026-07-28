import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { aiSprintPlanningService } from '@/lib/services/aiSprintPlanningService';
import { SprintAssignmentValidationError } from '@/lib/ai/sprintAssignment';
import { MotirAiError, MotirAiJobNotFoundError } from '@/lib/ai/errors';

// GET /api/ai/plan/sprint/:jobId/review (Subtask MOTIR-1750) — the proposed
// packing RESOLVED for render: the delta plus, per packed key, its work-item
// summary and the `is_blocked_by` blockers that are also in the packing.
//
// Why a read of its own rather than letting the browser use
// `GET /api/ai/jobs/:jobId`: that route returns the raw job result, which names
// work items by KEY only. Titles, kinds, estimates and the dependency captions
// are database facts, and the design requires them server-derived rather than
// guessed client-side. HTTP only — session, active project, ONE service call.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 404 },
    );
  }

  const { jobId } = await params;

  try {
    const review = await aiSprintPlanningService.reviewSprintPlan(jobId, ctx);
    return NextResponse.json(review, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    // A result this build cannot parse is a 400 with nothing rendered — the same
    // shape gate the approve applies, one seam earlier.
    if (err instanceof SprintAssignmentValidationError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
    }
    if (err instanceof MotirAiJobNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof MotirAiError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 502 });
    }
    throw err;
  }
}
