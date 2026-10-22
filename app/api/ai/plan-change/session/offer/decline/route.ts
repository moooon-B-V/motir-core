import { NextResponse } from 'next/server';

import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { planOfferService } from '@/lib/services/planOfferService';
import {
  mapPlanChangeError,
  missingSessionId,
  noActiveProject,
  readSessionId,
} from '../../../_errors';

// POST /api/ai/plan-change/session/offer/decline — the Decline button on a plan offer
// (Story MOTIR-9219 · MOTIR-9294). Body: { sessionId, offerTurnId }. Stamps the
// decision on the offer and answers the session; plans nothing, spends nothing.
// Replayable: a second decline answers the same session. A confirmed or superseded
// offer is 409. Submits no model job: NOT rate-limited, deliberately — the guide
// offer's decline precedent exactly.
//
// HTTP only (CLAUDE.md 4-layer): parse, call ONE service method, map errors.
export async function POST(req: Request): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();

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
    const result = await planOfferService.declinePlanOffer(offerTurnId, ctx, { sessionId });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapPlanChangeError(err);
    if (mapped) return mapped;
    throw err;
  }
}
