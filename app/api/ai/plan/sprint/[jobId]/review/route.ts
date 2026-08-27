import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { aiSprintPlanningService } from '@/lib/services/aiSprintPlanningService';
import { SprintAssignmentValidationError } from '@/lib/ai/sprintAssignment';
import { MotirAiError, MotirAiJobNotFoundError } from '@/lib/ai/errors';
import { aiPlanGateErrorResponse } from '@/lib/ai/planGateResponse';

// GET /api/ai/plan/sprint/:jobId/review (Subtask MOTIR-1750) — the proposed
// packing RESOLVED for render: the delta plus, per packed key, its work-item
// summary and the `is_blocked_by` blockers that are also in the packing.
//
// Why a read of its own rather than letting the browser use
// `GET /api/ai/jobs/:jobId`: that route returns the raw job result, which names
// work items by KEY only. Titles, kinds, estimates and the dependency captions
// are database facts, and the design requires them server-derived rather than
// guessed client-side. HTTP only — session, active project, ONE service call.
// NOT rate-limited, deliberately (MOTIR-2597): this route READS a job whose cost was already
// paid at submit time, where the `ai:generate` ceiling was spent. A limiter here would refuse a
// caller mid-generation — cutting off the answer they have already been charged for — without
// ever preventing a single provider call.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

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
    const gate = aiPlanGateErrorResponse(err);
    if (gate) return gate;
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
