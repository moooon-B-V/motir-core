import { NextResponse } from 'next/server';

import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import { mapPlanChangeError, noActiveProject, readSessionId } from '../../plan-change/_errors';

// POST /api/ai/guide/decline — DECLINE a guide turn's re-plan offer (Story
// MOTIR-8684 · MOTIR-8689; decision MOTIR-8685). Body: { turnId, sessionId }.
// Records a marker on the thread; plans nothing, spends nothing, decides no gate.
// Replayable. Submits no model job, so it is not rate-limited.
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
    const result = await planChangeSessionsService.declineGuideOffer(body.turnId, ctx, {
      sessionId,
    });
    if (!result) {
      return NextResponse.json(
        { code: 'NO_OFFER', error: 'That turn carries no re-plan offer.' },
        { status: 404 },
      );
    }
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapPlanChangeError(err);
    if (mapped) return mapped;
    throw err;
  }
}
