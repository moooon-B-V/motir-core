import { NextResponse } from 'next/server';
import { requireCompliantSession, refuseIfNonCompliant } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { aiPlanEditsService } from '@/lib/services/aiPlanEditsService';
import { MotirAiError, MotirAiOutOfCreditsError } from '@/lib/ai/errors';
import { aiPlanGateErrorResponse } from '@/lib/ai/planGateResponse';
import { enforceAiRateLimit } from '@/lib/rateLimit/aiGuard';
import {
  PlanNotEditableError,
  PlanNotFoundError,
  PlanRevisionInFlightError,
} from '@/lib/plans/errors';

// POST /api/ai/revise (Story MOTIR-3595 · Subtask MOTIR-3599) — ask Motir to
// change the plan you are REVIEWING.
//
// It mirrors `/api/ai/replan`'s shape exactly — same two gates, same rate-limit
// bucket, same `{ jobId, planId }` response — so the client has ONE contract
// across the four plan-edit submits rather than a fourth of its own. The single
// difference is the target: a PLAN id where the other three take a work-item key,
// and the `planId` that comes back is the SAME one that went in, because a
// revision lands on the plan the reviewer is holding rather than opening a second.
//
// Typed errors → status:
//   PlanNotFoundError            → 404 (unknown, or in another project — NOT 403:
//                                   a caller who cannot browse it must not learn
//                                   it exists)
//   PlanNotEditableError         → 409 (`approved` / `declined`, naming the status)
//   PlanRevisionInFlightError    → 409 (another revision holds this plan)
//   MotirAiOutOfCreditsError     → 402 · MotirAiError → 502
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

  // The same `ai:generate` bucket the three sibling submits spend, and spent in
  // the same place: after the gates, before the body is read, long before the
  // provider is called — a 429 afterwards has already paid the bill.
  const limited = await enforceAiRateLimit(ctx, 'ai:generate');
  if (limited) return limited;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ code: 'BAD_REQUEST', error: 'Invalid JSON body.' }, { status: 400 });
  }
  const planId = (body as { planId?: unknown })?.planId;
  if (typeof planId !== 'string' || !planId.trim()) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`planId` is required.' },
      { status: 400 },
    );
  }
  const prompt = (body as { prompt?: unknown })?.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`prompt` is required — a revision is an instruction.' },
      { status: 400 },
    );
  }

  try {
    const { jobId, planId: revisedPlanId } = await aiPlanEditsService.submitRevise(
      planId.trim(),
      prompt.trim(),
      ctx,
    );
    return NextResponse.json(
      { jobId, planId: revisedPlanId },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (err) {
    const gate = aiPlanGateErrorResponse(err);
    if (gate) return gate;
    if (err instanceof PlanNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof PlanNotEditableError || err instanceof PlanRevisionInFlightError) {
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
