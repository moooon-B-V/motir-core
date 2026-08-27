import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { aiPlanEditsService, InvalidTargetError } from '@/lib/services/aiPlanEditsService';
import { MotirAiError, MotirAiOutOfCreditsError } from '@/lib/ai/errors';
import { aiPlanGateErrorResponse } from '@/lib/ai/planGateResponse';
import { enforceAiRateLimit } from '@/lib/rateLimit/aiGuard';

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

  // The AI ceiling, applied on the door that SUBMITS the job (MOTIR-2597). Its own
  // `ai:generate` bucket, tighter than `ai:chat`, because a generation costs many
  // chat turns. Spent here — after the two gates, before the body is read and long
  // before the provider is called, since a 429 afterwards has already paid the bill.
  const limited = await enforceAiRateLimit(ctx, 'ai:generate');
  if (limited) return limited;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ code: 'BAD_REQUEST', error: 'Invalid JSON body.' }, { status: 400 });
  }
  const itemKey = (body as { itemKey?: unknown })?.itemKey;
  if (typeof itemKey !== 'string' || !itemKey.trim()) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`itemKey` is required.' },
      { status: 400 },
    );
  }

  try {
    // `planId` is the job's opened `generating` Plan (MOTIR-1743) — echoed
    // alongside `jobId`, additively, so a surface can link straight to the plan
    // without re-resolving it by `sourceJobId`. Consumers read it defensively.
    const { jobId, planId } = await aiPlanEditsService.submitExpand(
      itemKey.trim().toUpperCase(),
      ctx,
    );
    return NextResponse.json(
      { jobId, planId },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (err) {
    const gate = aiPlanGateErrorResponse(err);
    if (gate) return gate;
    if (err instanceof InvalidTargetError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
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
