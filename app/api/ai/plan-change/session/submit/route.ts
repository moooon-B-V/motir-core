import { NextResponse } from 'next/server';

import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import {
  mapPlanChangeError,
  missingSessionId,
  noActiveProject,
  readSessionId,
} from '../../_errors';
import { enforceAiRateLimit } from '@/lib/rateLimit/aiGuard';

// POST /api/ai/plan-change/session/submit — send the conversation's ACCUMULATED
// intent to the shipped plan-edit job contract (Story 7.30 · MOTIR-1728).
//
// The returned `jobId` is an ordinary `augment` job: the rail streams it from
// the EXISTING `GET /api/ai/augment/[jobId]` and approves its delta through the
// EXISTING approve route. This endpoint adds no job kind and no second
// stream/approve surface — it only decides WHAT prompt the shipped submit
// receives (every user turn, in order, instead of the latest one).
//
// HTTP only (CLAUDE.md 4-layer): call ONE service method and map typed errors —
// including the metered-AI ones (402 out-of-credits / 502 transport) the submit
// path can raise.
// The conversation to submit is named by `sessionId` in the body (MOTIR-6023).
export async function POST(req: Request): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();

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
  const sessionId = readSessionId((body as { sessionId?: unknown })?.sessionId);
  if (!sessionId) return missingSessionId();

  try {
    const result = await planChangeSessionsService.submit(ctx, { sessionId });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapPlanChangeError(err);
    if (mapped) return mapped;
    throw err;
  }
}
