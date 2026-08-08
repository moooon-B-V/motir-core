import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { aiPlanEditsService, InvalidTargetError } from '@/lib/services/aiPlanEditsService';
import { MotirAiError, MotirAiOutOfCreditsError } from '@/lib/ai/errors';
import { aiPlanGateErrorResponse } from '@/lib/ai/planGateResponse';

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
    const { jobId, planId } = await aiPlanEditsService.submitReplan(
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
