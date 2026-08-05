import { NextResponse } from 'next/server';

import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import { mapPlanChangeError, noActiveProject } from '../../_errors';

// POST /api/ai/plan-change/session/turns — append one turn to the active
// project's plan-change conversation (Story 7.30 · MOTIR-1728). Appending
// ACCUMULATES; it does not submit. The response is the updated session with its
// full ordered thread.
//
// `isAnswer` (MOTIR-2226, optional) marks the turn as the reply to the planner's
// pending question, which the composer sets when it sent from the answer bar. It
// is read strictly — anything that is not `true` is `false` — because it decides
// which disposition marker the transcript shows forever after.
//
// HTTP only (CLAUDE.md 4-layer): parse the body, call ONE service method, map
// typed errors. The service owns the row lock + `seq` allocation.
export async function POST(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ code: 'BAD_REQUEST', error: 'Invalid JSON body.' }, { status: 400 });
  }
  const rawBody = (body as { body?: unknown })?.body;
  if (typeof rawBody !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`body` is required.' },
      { status: 400 },
    );
  }

  try {
    const result = await planChangeSessionsService.appendTurn(rawBody, ctx, undefined, {
      isAnswer: (body as { isAnswer?: unknown })?.isAnswer === true,
    });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapPlanChangeError(err);
    if (mapped) return mapped;
    throw err;
  }
}
