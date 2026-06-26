import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { aiGenerationService } from '@/lib/services/aiGenerationService';
import { MotirAiError, MotirAiOutOfCreditsError } from '@/lib/ai/errors';

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
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 404 },
    );
  }

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
