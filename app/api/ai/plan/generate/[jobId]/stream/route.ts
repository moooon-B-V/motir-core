import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { aiGenerationService } from '@/lib/services/aiGenerationService';
import { failureReasonFrame } from '@/lib/ai/jobStream';
import { MotirAiError, MotirAiJobNotFoundError } from '@/lib/ai/errors';
import type { JobStreamEvent } from '@/lib/ai/types';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { aiPlanGateErrorResponse } from '@/lib/ai/planGateResponse';

// GET /api/ai/plan/generate/:jobId/stream (Subtask 7.4.4 · MOTIR-846) — the live
// channel the 7.4.9 generation UI subscribes to. Proxies the motir-ai
// `generate_tree` job stream (7.1.5 streamJob) to the browser as Server-Sent
// Events, so the surface shows `add` PlanItems appearing LIVE as the handler
// appends them, and closes on a terminal state. Browsers stream from CORE, never
// from motir-ai (the open-core invariant — the client is `server-only`).
//
// Thin HTTP layer over aiGenerationService (CLAUDE.md 4-layer): session-gated
// (getSession → 401) + active-project-gated (getActiveProject → 404), then it
// relays the typed JobStreamEvent frames the service yields. No `db` / no
// `motir-ai` import — the boundary lives in the `server-only` client.
//
// Status mapping mirrors the 7.3.4 chat stream: the session + project gates run
// BEFORE the stream opens, so they return real HTTP codes; the upstream fetch
// throws on its FIRST pull, before any SSE frame, so we PRIME the first frame and
// map a pre-stream failure to a real status (404 unknown job, 502 otherwise).
// Once frames flow the headers are sent, so a mid-stream failure can only surface
// as a terminal `error` SSE frame carrying the typed code. Out-of-credits is a
// FIRST-CLASS outcome HERE too: on the terminal `failed` status, failureReasonFrame
// appends an `error` frame carrying `MOTIR_AI_OUT_OF_CREDITS` (7.2.8/8.1.8) so the
// 7.4.9 UI learns WHY — the paywall — not just THAT generation failed.

/** Serialise one relayed job event as an SSE frame (`event:` + `data:` JSON). */
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
  const iterator = aiGenerationService
    .streamGeneration(jobId, ctx.projectId)
    [Symbol.asyncIterator]();

  // Prime the first frame so a pre-stream transport failure (motir-ai unreachable
  // / unknown job) maps to a real HTTP status rather than a stream that opens and
  // immediately errors.
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
          // On a terminal `failed` status, append the failure REASON as an `error`
          // frame (7.4.9 ← 8.1.8) so the client learns WHY — out-of-credits → the
          // paywall — not just THAT it failed. Once only.
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
        // Headers are already sent — surface the failure as a terminal SSE `error`
        // frame carrying the typed code (mapped through the 7.1.1 taxonomy), close.
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
    // Client disconnect (the browser closes EventSource) → release the upstream
    // reader so we don't leak the motir-ai connection.
    async cancel() {
      await iterator.return?.(undefined);
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
