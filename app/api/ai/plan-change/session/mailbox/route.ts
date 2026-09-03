import { NextResponse } from 'next/server';

import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { planChangeMailboxService } from '@/lib/services/planChangeMailboxService';
import { mapPlanChangeError, noActiveProject } from '../../_errors';

// POST /api/ai/plan-change/session/mailbox — attach ONE turn to the RUNNING
// planning job of the active project's conversation (Story MOTIR-4054 ·
// MOTIR-4067). The INGEST half of the boundary mailbox.
//
// ⚠️ IT DOES NOT INTERRUPT ANYTHING. The job reads this at a PHASE BOUNDARY —
// after an `author` completes, before the next `lay` opens — so a turn posted
// during an authoring session sits until that session finishes. That interval is
// real and can be long, which is why the answer is the mailbox AS IT STANDS
// rather than an acknowledgement: the composer can say "queued", and
// `design/ai-chat/plan-change-run-live.mock.html` draws that state.
//
// ⚠️ THE STOP IS NOT HERE. It rides the same pipe (`raiseStop` on the service),
// and the CONTROL that raises it — plus the job's terminal state and the stopped
// plan's disposition — is MOTIR-4068's. This route is the turn half only.
//
// HTTP only (CLAUDE.md 4-layer): parse the body, call ONE service method, map
// typed errors. The service owns the row lock, the `seq` allocation and the
// idempotency gate.
//
// NOT rate-limited, on the same reasoning as the sibling `turns` route
// (MOTIR-2597): this writes one row against a job that is ALREADY running and
// already paid for. No model job is submitted and no provider money is spent, so
// a ceiling here would only cap a database write. The AI ceiling guards the doors
// that SUBMIT.
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
  const rawBody = bag['body'];
  if (typeof rawBody !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`body` is required.' },
      { status: 400 },
    );
  }
  // ⚠️ REQUIRED, and the server does not invent one. A server-generated key
  // cannot recognise the SAME submit arriving twice — which is the entire
  // property this field exists for — so a caller that will not supply one is
  // told so rather than silently getting at-least-once delivery.
  const idempotencyKey = bag['idempotencyKey'];
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
    return NextResponse.json(
      {
        code: 'BAD_REQUEST',
        error: '`idempotencyKey` is required — it is what makes a retried submit a no-op.',
      },
      { status: 400 },
    );
  }
  // Read STRICTLY: anything that is not the literal `restart` is `fold`. The two
  // are not symmetric — folding carries on, restarting withdraws what the pass
  // appended — so an unrecognised value must land on the branch that destroys
  // nothing, which is the same reading `motir-ai`'s parse takes.
  const disposition = bag['disposition'] === 'restart' ? 'restart' : 'fold';
  const rawTarget = bag['target'];
  const restartTarget = typeof rawTarget === 'string' && rawTarget.length > 0 ? rawTarget : null;

  try {
    const result = await planChangeMailboxService.attachTurn(
      { jobId, body: rawBody, idempotencyKey, disposition, restartTarget },
      ctx,
    );
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapPlanChangeError(err);
    if (mapped) return mapped;
    throw err;
  }
}

// GET /api/ai/plan-change/session/mailbox?jobId=… — WHAT IS STILL WAITING for
// that run (Story MOTIR-4054 · MOTIR-4274). Session-authenticated, and it does
// NOT consume: the boundary read is motir-ai's alone.
//
// ⚠️ THIS EXISTS BECAUSE THE OTHER REPO EMITS NOTHING. `motir-ai` records the
// consumed turn ids in its `MailboxReport` and that report never reaches
// motir-core — the planning handler returns `{ planDelta, summary }` — and no
// stream frame is emitted at a boundary either. So a composer that queued a turn
// cannot be TOLD it was read; it can only ask what is still waiting, and infer
// the answer from the turn's absence.
//
// That is a poll, and a poll is worse than a push. It is bounded on purpose: the
// client only asks while a run is streaming AND it has something queued, so an
// ordinary run — nobody typed anything — makes zero requests. If motir-ai ever
// emits a `folded` frame, this door stops being the only answer and the polling
// goes with it.
export async function GET(req: Request): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();

  const jobId = new URL(req.url).searchParams.get('jobId');
  if (!jobId) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`jobId` is required.' },
      { status: 400 },
    );
  }

  try {
    const result = await planChangeMailboxService.peekForJob(jobId, ctx);
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapPlanChangeError(err);
    if (mapped) return mapped;
    throw err;
  }
}
