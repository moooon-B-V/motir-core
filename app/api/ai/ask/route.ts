import { NextResponse } from 'next/server';

import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { aiAskService } from '@/lib/services/aiAskService';
import { mapPlanChangeError, noActiveProject } from '../plan-change/_errors';
import { enforceAiRateLimit } from '@/lib/rateLimit/aiGuard';

// POST /api/ai/ask — the project conversation's ONE DOOR for a user turn
// (Story MOTIR-1343 · MOTIR-1819; contract in
// `docs/decisions/conversation-turn-intent.md`).
//
// ⚠️ IT IS NOT AN "ASK-ONLY" ENDPOINT THE CLIENT PICKS WHEN IT ALREADY KNOWS.
// The person types into one composer with no mode to flip, so the client posts
// the TEXT and nothing else — never an `intent`. The turn is submitted as
// `ask_project`, and what it turns out to be is the JOB'S answer: a question is
// answered with citations, a plan-change request is handed back and dispatched
// to the SHIPPED plan-change submit (see the settle route). An `intent` in this
// body would be the mode re-entering through the back door, so it is not read —
// and `tests/ai/askRoutes.test.ts` asserts that it is not.
//
// Two bodies, one door:
//   { body, isAnswer? }          — a new turn. `isAnswer` is ADR §1's wire field
//                                  and is NOT an intent: it records which
//                                  affordance sent the turn (the shipped
//                                  `isAnswer` precedent), so the thread can say
//                                  later whether the planner's question was
//                                  answered or superseded.
//   { turnId, flip? }            — RE-RUN a turn already on the thread: the retry
//                                  after a failed submit (`flip` absent) and the
//                                  correction affordance (`flip: true`). The
//                                  DIRECTION of a flip is derived server-side
//                                  from what the turn ran as; the client names
//                                  the turn, never the intent.
//
// HTTP only (CLAUDE.md 4-layer): parse, call ONE service method, map typed
// errors. No `db`, no `$transaction`, no `motir-ai` import.
export async function POST(req: Request): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();

  // The AI ceiling on the door that SUBMITS the job — the same `ai:generate`
  // bucket the plan-change submit spends, because an ask turn costs a real model
  // run. Spent after the two gates and before the body is read, since a 429 after
  // the provider call has already paid the bill.
  const limited = await enforceAiRateLimit(ctx, 'ai:generate');
  if (limited) return limited;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ code: 'BAD_REQUEST', error: 'Invalid JSON body.' }, { status: 400 });
  }
  const body = raw as {
    body?: unknown;
    turnId?: unknown;
    flip?: unknown;
    isAnswer?: unknown;
  };

  try {
    if (typeof body.turnId === 'string' && body.turnId.length > 0) {
      const result = await aiAskService.resubmit(body.turnId, ctx, { flip: body.flip === true });
      return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
    }
    if (typeof body.body !== 'string') {
      return NextResponse.json(
        { code: 'BAD_REQUEST', error: '`body` or `turnId` is required.' },
        { status: 400 },
      );
    }
    const result = await aiAskService.submitTurn(body.body, ctx, {
      isAnswer: body.isAnswer === true,
    });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapPlanChangeError(err);
    if (mapped) return mapped;
    throw err;
  }
}
