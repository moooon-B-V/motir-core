import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { aiSprintPlanningService } from '@/lib/services/aiSprintPlanningService';
import { failureReasonFrame } from '@/lib/ai/jobStream';
import { MotirAiError, MotirAiJobNotFoundError } from '@/lib/ai/errors';
import type { JobStreamEvent } from '@/lib/ai/types';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { aiPlanGateErrorResponse } from '@/lib/ai/planGateResponse';

// GET /api/ai/plan/sprint/:jobId/stream (Subtask 7.13.5 · MOTIR-918) — relay the
// 7.1.4 job stream for a sprint-planning job to the browser as SSE. Browsers
// stream from CORE, never from motir-ai: the service token never leaves the
// server, and the session gate is applied here.
//
// Structurally identical to the plan-edit stream relays (`…/expand/[jobId]/
// stream`) — the FIRST frame is pulled before the response is committed, so a
// 404 / 502 from motir-ai surfaces as a real HTTP status instead of a 200 whose
// body immediately errors; every later failure becomes an `error` frame, since
// the status line is already sent by then.

function formatFrame(ev: JobStreamEvent): string {
  return `event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`;
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
} as const;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

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
  const iterator = aiSprintPlanningService
    .streamSprintPlan(jobId, ctx.projectId)
    [Symbol.asyncIterator]();

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
        while (!result.done) {
          controller.enqueue(encoder.encode(formatFrame(result.value)));
          if (!reasonEmitted) {
            const reason = await failureReasonFrame(jobId, result.value, ctx.projectId);
            if (reason) {
              reasonEmitted = true;
              controller.enqueue(encoder.encode(formatFrame(reason)));
            }
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
