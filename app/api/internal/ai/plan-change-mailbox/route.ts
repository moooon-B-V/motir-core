import { NextResponse } from 'next/server';
import { authenticateAndLimitJobRequest } from '@/lib/ai/jobAuth';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import { planChangeMailboxService } from '@/lib/services/planChangeMailboxService';

// POST /api/internal/ai/plan-change-mailbox  { jobId }  (Story MOTIR-4054 ·
// MOTIR-4067) — ONE BOUNDARY CHECK. What `motir-ai`'s `runWalk` reads in the gap
// between `authorPending()` and the next `layLevel()`.
//
// ⚠️ THE READ SHAPE IS THE CONTRACT, AND THE CONSUMER LANDED FIRST. The answer
// is exactly `{ turns: [{ id, text, receivedAt, disposition, target }], stopped }`
// — the shape `motir-ai` `src/llm/mailbox.ts` (MOTIR-4060, merged) already
// accepts. Its parse is TOTAL and never throws, so a field this side renames is
// not an error over there: the entry is silently DROPPED. That is the right
// behaviour for a producer that has not shipped yet and the wrong thing to find
// out at a planning run, which is why the cross-repo fixture holds the
// consumer's own reading rather than a round-trip through our own types.
//
// ⚠️ POST, NOT GET, AND THE VERB IS THE POINT: this read CONSUMES. Everything it
// returns is stamped `consumed_at` in the same transaction, so a turn read at one
// boundary is not read again at the next. A GET would invite a proxy, a retry or
// a prefetch to swallow a user's sentence.
//
// ⚠️ THE STOP IS NOT CONSUMED — it is derived from a stop entry EXISTING, so
// every boundary after the first still reads `stopped: true`. A run that has been
// ended stays ended.
//
// ⚠️ AN EMPTY MAILBOX IS A 200. The card's criterion is that the run can tell
// "nothing waiting" from "could not tell", and only the first lets it proceed on
// the strength of the answer. So a job with no thread, or a thread that has moved
// on to another run, answers `{ turns: [], stopped: false }` — which is TRUE —
// and never a 404 that a caller would have to read as ambiguous.
//
// Service-to-service ONLY: the §4a service bearer + the §4b job token via
// `authenticateAndLimitJobRequest`. The mailbox is read AS the token's user
// within the token's project, so a job token from another tenant reads an empty
// mailbox rather than somebody else's — the tenancy holds through the RLS path
// (`withWorkspaceContext`), not through a service-layer comparison.
export async function POST(req: Request): Promise<Response> {
  let auth;
  try {
    auth = await authenticateAndLimitJobRequest(req);
  } catch (err) {
    const failure = mapJobRequestError(err);
    if (failure) return failure;
    throw err;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ code: 'BAD_REQUEST', error: 'Invalid JSON body.' }, { status: 400 });
  }
  const jobId = (body as { jobId?: unknown })?.jobId;
  if (typeof jobId !== 'string' || jobId.length === 0) {
    return NextResponse.json(
      { code: 'JOB_ID_REQUIRED', error: '`jobId` is required.' },
      { status: 400 },
    );
  }

  const delivery = await planChangeMailboxService.readForBoundary(jobId, {
    userId: auth.ctx.userId,
    workspaceId: auth.ctx.workspaceId,
    projectId: auth.projectId,
  });
  return NextResponse.json(delivery, { headers: { 'Cache-Control': 'private, no-store' } });
}
