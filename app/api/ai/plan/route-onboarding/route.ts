import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { aiGenerationService } from '@/lib/services/aiGenerationService';
import { MotirAiError, MotirAiOutOfCreditsError } from '@/lib/ai/errors';
import { aiPlanGateErrorResponse } from '@/lib/ai/planGateResponse';
import { enforceAiRateLimit } from '@/lib/rateLimit/aiGuard';

// POST /api/ai/plan/route-onboarding (Story MOTIR-4753 · MOTIR-4769) — the plan
// window has just OPENED on a project whose first plan has never been approved.
// Ask motir-ai ONE question and return the job to watch: can this project be
// planned from what it has, and if not, which onboarding does the user go to?
//
// ⚠️ IT OPENS NO PLAN, and that is the difference from `…/plan/generate` rather
// than an omission. The run HALTS on every outcome — `continue` included
// (MOTIR-4767) — so it proposes nothing and closes nothing; a `Plan` row bound
// to it would sit `generating` for a job that was never going to write to it.
//
// ⚠️ AND IT IS THE ONLY DOOR THAT ASKS. `…/plan/generate` is what every LATER
// ask goes through, and it must never request a verdict: `onboardingRanAt` is
// stamped on the first plan APPROVED, so it is still null while a `continue`
// project does its actual planning, and a marker-derived flag there would route
// that user's every ask, forever, and plan nothing.
//
// ⚠️ NOTHING IS TAKEN FROM THE CLIENT. There is no body. The project is the
// server-resolved active project and the marker is read off it, so a caller
// cannot ask for a verdict on somebody else's terms — which would be a caller
// who could route a user into onboarding they do not need.
//
// A project whose marker is already stamped gets `{ jobId: null }`: there is no
// route to decide, and saying so is cheaper for the surface than a 4xx it would
// have to special-case. Thin HTTP layer over one service method (CLAUDE.md
// 4-layer); the `ai:plan` gate is the service's, beside generation's.
export async function POST(): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 404 },
    );
  }

  // NOTHING TO DECIDE for a project that has already had a plan approved. Answered
  // before the ceiling is spent and before motir-ai is touched: this is a fact
  // about the row in hand, not a question for anybody.
  if (ctx.project.onboardingRanAt) {
    return NextResponse.json(
      { jobId: null },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  }

  // The same ceiling generation spends (MOTIR-2597): the verdict is a model call
  // on the planner, and it is spent on the door that SUBMITS rather than after.
  const limited = await enforceAiRateLimit(ctx, 'ai:generate');
  if (limited) return limited;

  try {
    const { jobId } = await aiGenerationService.startRoutingRun(ctx);
    return NextResponse.json({ jobId }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const gate = aiPlanGateErrorResponse(err);
    if (gate) return gate;
    if (err instanceof MotirAiOutOfCreditsError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 402 });
    }
    if (err instanceof MotirAiError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 502 });
    }
    throw err;
  }
}
