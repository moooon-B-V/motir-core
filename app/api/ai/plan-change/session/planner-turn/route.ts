import { NextResponse } from 'next/server';

import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import { contextualPlanningService } from '@/lib/services/contextualPlanningService';
import { MotirAiError, MotirAiJobNotFoundError } from '@/lib/ai/errors';
import { mapPlanChangeError, noActiveProject } from '../../_errors';

// POST /api/ai/plan-change/session/planner-turn — record the PLANNER's turn for
// a settled planning job (MOTIR-2226, consuming MOTIR-2222).
//
// WHY A ROUTE AT ALL. The planning job's result carries the planner's utterance,
// and nothing in core observes that job finishing: the run is watched by the
// BROWSER's SSE subscription, and motir-ai calls no webhook back. So the client
// that saw the stream settle is the one that tells the server to go read the
// result and file it on the thread. The alternative — persisting from inside the
// stream relay — would tie a durable write to a connection the user can close
// mid-flight.
//
// That makes the call REPLAYABLE by construction (a reload, a second tab, a
// retried settle), which is why the service keys the append on the job id and
// verifies the job belongs to this thread. This route trusts neither: it forwards
// the id and lets the service decide.
//
// HTTP only (CLAUDE.md 4-layer): parse, call ONE service method, map typed
// errors — including the motir-ai read's (404 unknown job / 502 transport).
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
  const jobId = (body as { jobId?: unknown })?.jobId;
  if (typeof jobId !== 'string' || jobId.length === 0) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`jobId` is required.' },
      { status: 400 },
    );
  }

  // The ANCHORED thread (MOTIR-909/910) narrates through the same endpoint,
  // addressed by its anchor set — the contextual service owns scope resolution
  // and its view gate, so the client never computes a scope key.
  const anchorId = (body as { anchorId?: unknown })?.anchorId;
  const rawTargets = (body as { targetKeys?: unknown })?.targetKeys;
  if (rawTargets !== undefined && !Array.isArray(rawTargets)) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`targetKeys` must be an array of identifiers.' },
      { status: 400 },
    );
  }
  const targetKeys = (rawTargets ?? []).filter((k: unknown): k is string => typeof k === 'string');

  try {
    const result =
      typeof anchorId === 'string' && anchorId.length > 0
        ? await contextualPlanningService.recordPlannerTurnForWorkItem(
            { anchorId, targetKeys, jobId },
            ctx,
          )
        : await planChangeSessionsService.recordPlannerTurn(jobId, ctx);
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    if (err instanceof MotirAiJobNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof MotirAiError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 502 });
    }
    const mapped = mapPlanChangeError(err);
    if (mapped) return mapped;
    throw err;
  }
}
