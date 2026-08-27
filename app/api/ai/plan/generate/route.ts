import { NextResponse } from 'next/server';
import { requireCompliantSession, refuseIfNonCompliant } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { aiGenerationService } from '@/lib/services/aiGenerationService';
import { MotirAiError, MotirAiOutOfCreditsError } from '@/lib/ai/errors';
import { aiPlanGateErrorResponse } from '@/lib/ai/planGateResponse';
import { enforceAiRateLimit } from '@/lib/rateLimit/aiGuard';

// POST /api/ai/plan/generate (Subtask 7.4.4 · MOTIR-846) — open a `Plan`
// (status `generating`) for the active project and submit the `generate_tree`
// job, returning `{ jobId, planId }`. The 7.4.9 generation UI then opens
// `GET …/:jobId/stream` to watch `add` PlanItems appear live, and reads the plan
// via the 7.21 `GET /api/plans/:id`. Nothing materializes here — a real work-item
// tree exists only when the user APPROVES the plan (7.21 approve/materialize).
//
// Thin HTTP layer over aiGenerationService (CLAUDE.md 4-layer): session-gated
// (getSession → 401) + active-project-gated (getActiveProject → 404, the project
// analogue of getSession, mirroring /api/board), parse the optional prompt, call
// ONE service method, map typed errors. No `db` / no `motir-ai` import — the
// open-core boundary lives in the `server-only` client the service calls.
//
// Project comes from the server-resolved active-project context, never the client,
// so a cross-tenant project is unreachable here (it's the user's OWN active
// project); a null context is simply "no active project" → 404 (no-leak, #26).
//
// Out-of-credits is a FIRST-CLASS typed outcome (7.2 metering): the credit gate's
// refusal (7.2.8 → 402 `out_of_credits`) surfaces as a DISTINCT 402
// `MOTIR_AI_OUT_OF_CREDITS` the 7.4.9 UI branches to the paywall — never collapsed
// into the generic 502 every other motir-ai failure maps to.
export async function POST(req: Request): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

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

  // The body is optional; an unparseable body is treated as an empty one (no
  // required fields — generation seeds from the project's pre-plan context).
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const rawPrompt = (body as { prompt?: unknown })?.prompt;
  const prompt = typeof rawPrompt === 'string' && rawPrompt.trim() ? rawPrompt.trim() : null;

  try {
    const { jobId, planId } = await aiGenerationService.startGeneration(ctx, { prompt });
    return NextResponse.json(
      { jobId, planId },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (err) {
    const gate = aiPlanGateErrorResponse(err);
    if (gate) return gate;
    if (err instanceof MotirAiOutOfCreditsError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 402 });
    }
    // Any other motir-ai-side failure (unreachable / misconfigured / rejected
    // envelope) maps through the 7.1.1 taxonomy → 502: the upstream dependency
    // failed, not the caller's request.
    if (err instanceof MotirAiError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 502 });
    }
    throw err;
  }
}
