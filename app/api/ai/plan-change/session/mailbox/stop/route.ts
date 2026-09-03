import { NextResponse } from 'next/server';

import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { planChangeMailboxService } from '@/lib/services/planChangeMailboxService';
import { mapPlanChangeError, noActiveProject } from '../../../_errors';

// POST /api/ai/plan-change/session/mailbox/stop — END the RUNNING planning job of
// the active project's conversation (Story MOTIR-4054 · MOTIR-4068).
//
// ⚠️ THE SAME MAILBOX AS A TURN, taking the other kind — never a second channel.
// MOTIR-4067's store gives turns and the stop ONE `seq` sequence per job, so a
// stop and a turn typed before it are read in the order they were made. Two pipes
// for one boundary check is exactly how that ordering is lost.
//
// ⚠️ AND MARKING THE JOB IS NOT A STOP UNTIL THE WALK ASKS. `runWalk` reads the
// flag at its next PHASE BOUNDARY, which can be a whole authoring session away.
// This route returns as soon as the flag is stored; it does not wait, and the
// surface must not claim the run is over on the strength of its answer — the
// composer's bar says *stopping* until the run actually ends.
//
// ⚠️ NOT AN ERROR PATH. Stopping a run that has already finished, or already been
// stopped, is a clean NO-OP that answers 200 with the mailbox as it stands. The
// control is reachable in states where the click is redundant — the run can
// settle between render and click — so it has to be safe there, and a refusal the
// user cannot act on is worse than an entry nobody reads. That is the one place
// this door is deliberately unlike the TURN door beside it, which refuses.
//
// HTTP only (CLAUDE.md 4-layer): parse the body, call ONE service method, map
// typed errors. Not rate-limited, for the same reason as its siblings: it writes
// one row against a job that is already running and already paid for.
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
  const bag = (body ?? {}) as Record<string, unknown>;

  const jobId = bag['jobId'];
  if (typeof jobId !== 'string' || jobId.length === 0) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`jobId` is required.' },
      { status: 400 },
    );
  }
  // REQUIRED, as on the turn door: a double-clicked Stop must raise ONE stop, and
  // only a key the caller owns can recognise the second click as the same act.
  const idempotencyKey = bag['idempotencyKey'];
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
    return NextResponse.json(
      {
        code: 'BAD_REQUEST',
        error: '`idempotencyKey` is required — it is what makes a second click a no-op.',
      },
      { status: 400 },
    );
  }

  try {
    const result = await planChangeMailboxService.raiseStop(jobId, idempotencyKey, ctx);
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapPlanChangeError(err);
    if (mapped) return mapped;
    throw err;
  }
}
