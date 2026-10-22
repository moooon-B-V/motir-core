import { NextResponse } from 'next/server';

import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { planOfferStartService } from '@/lib/services/planOfferStartService';
import {
  mapPlanChangeError,
  missingSessionId,
  noActiveProject,
  readSessionId,
} from '../../../_errors';
import { enforceAiRateLimit } from '@/lib/rateLimit/aiGuard';

// POST /api/ai/plan-change/session/offer/confirm — the Confirm button on a plan offer
// (Story MOTIR-9219 · MOTIR-9291). Starts the plan the offer on `offerTurnId`
// describes, exactly once: a second press answers the first one's session and job.
//
// The answer is `{ sessionId, jobId, planId, session }`. `sessionId` may name a
// conversation other than the one on screen — an offer with a target plans on the
// caller's session for that card — and the client switches to it. A refusal is 409
// `{ code, error, reason }`; the rail turns `reason` into its cannot-start line.
//
// HTTP only (CLAUDE.md 4-layer): call ONE service method and map typed errors —
// including the metered-AI ones (402 out-of-credits / 502 transport) the start can
// raise.
export async function POST(req: Request): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();

  // The AI ceiling, on the door that SUBMITS the job (MOTIR-2597): spent before the
  // body is read and long before the provider is called.
  const limited = await enforceAiRateLimit(ctx, 'ai:generate');
  if (limited) return limited;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ code: 'BAD_REQUEST', error: 'Invalid JSON body.' }, { status: 400 });
  }
  const sessionId = readSessionId((body as { sessionId?: unknown })?.sessionId);
  if (!sessionId) return missingSessionId();
  const offerTurnId = readSessionId((body as { offerTurnId?: unknown })?.offerTurnId);
  if (!offerTurnId) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`offerTurnId` is required — name the offer by its turn.' },
      { status: 400 },
    );
  }

  try {
    const result = await planOfferStartService.confirmPlanOffer(ctx, {
      conversationId: sessionId,
      offerTurnId,
    });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapPlanChangeError(err);
    if (mapped) return mapped;
    throw err;
  }
}
