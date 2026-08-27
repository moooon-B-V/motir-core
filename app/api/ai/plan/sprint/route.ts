import { NextResponse } from 'next/server';
import { requireCompliantSession, refuseIfNonCompliant } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import {
  aiSprintPlanningService,
  SprintPlanningDisabledError,
} from '@/lib/services/aiSprintPlanningService';
import { MotirAiError, MotirAiOutOfCreditsError } from '@/lib/ai/errors';
import { aiPlanGateErrorResponse } from '@/lib/ai/planGateResponse';
import { enforceAiRateLimit } from '@/lib/rateLimit/aiGuard';

// POST /api/ai/plan/sprint (Subtask 7.13.5 · MOTIR-918) — submit a `plan_sprint`
// packing job for the active project. HTTP only: session, active project, ONE
// service call, typed errors → status codes.
export async function POST(): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  // A caller outside the tenant has no active project to resolve, so a foreign
  // project reads as "none" — 404, never 403 (no existence leak).
  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 404 },
    );
  }

  // The 2FA hold (MOTIR-3653) — placed AFTER the no-project arm, which keeps
  // its own answer. `ctx.userId` is the session user `getWorkspaceContext`
  // already resolved, so this costs one policy query and no second auth trip.
  const hold = await refuseIfNonCompliant(ctx.userId);
  if (hold) return hold;

  // The AI ceiling, applied on the door that SUBMITS the job (MOTIR-2597). Its own
  // `ai:generate` bucket, tighter than `ai:chat`, because a generation costs many
  // chat turns. Spent here — after the two gates, before the body is read and long
  // before the provider is called, since a 429 afterwards has already paid the bill.
  const limited = await enforceAiRateLimit(ctx, 'ai:generate');
  if (limited) return limited;

  try {
    const { jobId } = await aiSprintPlanningService.submitSprintPlan(ctx);
    return NextResponse.json({ jobId }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const gate = aiPlanGateErrorResponse(err);
    if (gate) return gate;
    if (err instanceof SprintPlanningDisabledError) {
      // 409: the request is well-formed, the project's configuration refuses it.
      return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
    }
    if (err instanceof MotirAiOutOfCreditsError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 402 });
    }
    if (err instanceof MotirAiError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 502 });
    }
    throw err;
  }
}
