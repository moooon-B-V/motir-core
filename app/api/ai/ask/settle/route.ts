import { NextResponse } from 'next/server';

import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { aiAskService } from '@/lib/services/aiAskService';
import { mapPlanChangeError, noActiveProject } from '../../plan-change/_errors';

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
    const result = await aiAskService.settle(jobId, ctx);
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapPlanChangeError(err);
    if (mapped) return mapped;
    throw err;
  }
}
