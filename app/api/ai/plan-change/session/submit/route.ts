import { NextResponse } from 'next/server';

import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import { mapPlanChangeError, noActiveProject } from '../../_errors';

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
export async function POST(): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();

  try {
    const result = await planChangeSessionsService.submit(ctx);
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapPlanChangeError(err);
    if (mapped) return mapped;
    throw err;
  }
}
