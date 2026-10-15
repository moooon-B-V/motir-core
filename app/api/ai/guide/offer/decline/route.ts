import { NextResponse } from 'next/server';

import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { guideLandingService } from '@/lib/services/guideLandingService';
import { mapPlanChangeError, noActiveProject, readSessionId } from '../../../plan-change/_errors';

// POST /api/ai/guide/offer/decline — DECLINE a guide reply's re-plan offer (Story
// MOTIR-8684 · MOTIR-8689; decision MOTIR-8685). Body: { sessionId, turnId }.
// Stamps the decision on the offer; plans nothing, spends nothing, decides no gate.
// Replayable. Submits no model job: NOT rate-limited, deliberately — the guide
// settle precedent exactly (one stamp on a thread already open).
//
// HTTP only (CLAUDE.md 4-layer): parse, call ONE service method, map errors.
export async function POST(req: Request): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ code: 'BAD_REQUEST', error: 'Invalid JSON body.' }, { status: 400 });
  }
  const body = (raw ?? {}) as { turnId?: unknown; sessionId?: unknown };
  const sessionId = readSessionId(body.sessionId);
  if (typeof body.turnId !== 'string' || body.turnId.length === 0 || !sessionId) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`turnId` and `sessionId` are required.' },
      { status: 400 },
    );
  }

  try {
    const result = await guideLandingService.declineReplanOffer(body.turnId, ctx, { sessionId });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapPlanChangeError(err);
    if (mapped) return mapped;
    throw err;
  }
}
