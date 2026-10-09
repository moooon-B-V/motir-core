import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { aiPlanEditsService } from '@/lib/services/aiPlanEditsService';
import { failureReasonFrame, terminalStatusOf, walkPositionOf } from '@/lib/ai/jobStream';
import type { JobWalkPosition } from '@/lib/planChange/failureRecord';
import { planSessionEndService } from '@/lib/services/planSessionEndService';
import { MotirAiError, MotirAiJobNotFoundError } from '@/lib/ai/errors';
import type { JobStreamEvent } from '@/lib/ai/types';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { aiPlanGateErrorResponse } from '@/lib/ai/planGateResponse';

function formatFrame(ev: JobStreamEvent): string {
  return `event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`;
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
} as const;

// NOT rate-limited, deliberately (MOTIR-2597): this route READS a job whose cost was already
// paid at submit time, where the `ai:generate` ceiling was spent. A limiter here would refuse a
// caller mid-generation — cutting off the answer they have already been charged for — without
// ever preventing a single provider call.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 404 },
    );
  }

  const { jobId } = await params;

  // `ai:plan` (Story MOTIR-2291 · Subtask MOTIR-2359) — asserted BEFORE the
  // stream opens, so the refusal is a real HTTP status and no SSE frame is ever
  // written to an actor who may not plan.
  //
  // ⚠️ WHAT THIS GATE DOES AND DOES NOT ESTABLISH. It establishes that the caller
  // may plan in THEIR OWN project. It does NOT establish that the job belongs to
  // that project: a jobId is still readable across projects by an actor who has
  // one, because motir-ai answers `GET /v1/jobs/:id` with no tenant filter. The
  // id is now SENT (see `getJob` / `streamJob`); MOTIR-2360 is the card that makes
  // motir-ai enforce it.
  try {
    await projectAccessService.assertPermission(
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      'ai:plan',
    );
  } catch (err) {
    const gate = aiPlanGateErrorResponse(err);
    if (gate) return gate;
    throw err;
  }
  const iterator = aiPlanEditsService.streamAugment(jobId, ctx.projectId)[Symbol.asyncIterator]();

  let first: IteratorResult<JobStreamEvent>;
  try {
    first = await iterator.next();
  } catch (err) {
    await iterator.return?.(undefined);
    if (err instanceof MotirAiJobNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof MotirAiError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 502 });
    }
    throw err;
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        let result = first;
        let reasonEmitted = false;
        let lastPosition: JobWalkPosition | null = null;
        while (!result.done) {
          controller.enqueue(encoder.encode(formatFrame(result.value)));
          if (!reasonEmitted) {
            const reason = await failureReasonFrame(jobId, result.value, ctx.projectId);
            if (reason) {
              reasonEmitted = true;
              controller.enqueue(encoder.encode(formatFrame(reason)));
            }
          }
          // The last `walk_position` frame is the stop point when the terminal
          // problem carries none (a machine that died names no `walkStop`).
          lastPosition = walkPositionOf(result.value) ?? lastPosition;
          // A failed attempt is SETTLED here, server-side, before the stream closes
          // (AMENDMENT 23's 2026-10-09 sub-amendment): a failed hosted walk RECORDS its
          // failure and leaves the session open; a canceled job, a `guide` session or a
          // plan that is not `generating` still ends it. Best-effort: the abandoned-plan
          // sweep records the same failure as the backstop, so a write that fails here
          // is not lost.
          const terminal = terminalStatusOf(result.value);
          if (terminal) {
            await planSessionEndService
              .settleFailedJob(jobId, ctx, { status: terminal, lastPosition })
              .catch((err) =>
                console.warn(`[stream] settling the session of job ${jobId} failed`, err),
              );
          }
          result = await iterator.next();
        }
      } catch (err) {
        const code = err instanceof MotirAiError ? err.code : 'INTERNAL_ERROR';
        const message = err instanceof Error ? err.message : 'stream failed';
        controller.enqueue(
          encoder.encode(formatFrame({ event: 'error', data: { code, message } })),
        );
      } finally {
        await iterator.return?.(undefined);
        controller.close();
      }
    },
    async cancel() {
      await iterator.return?.(undefined);
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
