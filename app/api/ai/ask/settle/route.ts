import { NextResponse } from 'next/server';

import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { aiAskService } from '@/lib/services/aiAskService';
import { mapPlanChangeError, noActiveProject, readSessionId } from '../../plan-change/_errors';

// POST /api/ai/ask/settle — file what a finished `ask_project` job produced
// (Story MOTIR-1343 · MOTIR-1819).
//
// WHY A ROUTE AT ALL — the same reason `…/plan-change/session/planner-turn`
// exists, and the same mechanics: nothing in core observes a motir-ai job
// finishing (the run is watched by the BROWSER's SSE subscription, and motir-ai
// calls no webhook back), so the client that saw the stream settle is the one
// that tells the server to go read the result and file it. Persisting from
// inside the stream relay would tie a durable write to a connection the user can
// close mid-flight.
//
// That makes the call REPLAYABLE by construction (a reload, a second tab, a
// retried settle), which is why the service keys the answer append on the job id
// and guards the redirect on the turn's current intent. This route trusts
// neither: it forwards the id and lets the service decide.
//
// A `debug` verdict (MOTIR-7047 · the ADR's AMENDMENT 1) answers
// `{ outcome: 'debugging', jobId, session }` — `jobId` is the ONE `debug_bug` job
// now running for the turn. Its gates answer here as typed errors: a caller
// without `work_item:edit` is a 403 `PERMISSION_DENIED`, an anchor that no longer
// resolves for them is the 404 `NOT_FOUND`, out of credits is the 402 — and in
// every one of those no job was submitted.
//
// Settling THAT `debug_bug` job (MOTIR-7049) LANDS it: the ONE card the ADR's
// A1.4 allows is written as the caller, the handler's reply is appended, and the
// answer is `{ outcome: 'debugged', landing: { outcome, workItemKey, title,
// createdInTriage }, session }`. Replayed, it returns the same `landing` and
// writes nothing. Its refusals write nothing either: a malformed result is a 502
// `INVALID_AUTHORED_BUG` naming the field, a named card that does not resolve for
// the caller the 404 `NOT_FOUND`, a `diagnose` anchored on a card that is not a
// triage bug a 422, and a card edited mid-write a retryable 409.
//
// A MID-RUN turn (MOTIR-7996) settles to two more outcomes, shaped like the rest:
// `{ outcome: 'forwarded', delivery, session }` — the answering session read the
// turn as a change and its words went down the running job's mailbox — and
// `{ outcome: 'forward_refused', code, jobStatus, text, session }` — the run had
// ended, nothing was written, and `text` is the words to hand back to the person.
//
// NOT rate-limited, deliberately (the `…/planner-turn` precedent): this reads a
// job that was already submitted and already paid for at the `ai:generate`
// ceiling. A limiter here would cap a database write and prevent no provider call
// — while refusing a caller the answer they have already been charged for.
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
  const jobId = (raw as { jobId?: unknown })?.jobId;
  if (typeof jobId !== 'string' || jobId.length === 0) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`jobId` is required.' },
      { status: 400 },
    );
  }

  try {
    // The conversation the job was asked on (MOTIR-6023), when the client names it.
    const sessionId = readSessionId((raw as { sessionId?: unknown })?.sessionId);
    const result = await aiAskService.settle(jobId, ctx, sessionId ? { sessionId } : {});
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapPlanChangeError(err);
    if (mapped) return mapped;
    throw err;
  }
}
