import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { aiExplanationService } from '@/lib/services/aiExplanationService';
import { MotirAiError, MotirAiJobNotFoundError } from '@/lib/ai/errors';
import type { JobStreamEvent } from '@/lib/ai/types';

// GET /api/ai/explanation/:jobId/stream (Subtask 8.8.12) — the live channel the
// create-modal / edit-form drafting UI subscribes to. Proxies the motir-ai
// `generate_explanation` job stream (8.8.11) to the browser as Server-Sent
// Events: `token` frames (markdown deltas the editor appends live) + a terminal
// `explanation` frame (the full draft) + status, closing on a terminal state.
//
// A line-for-line mirror of /api/ai/chat/:jobId/stream (the only differences are
// the service method + the doc): session-gated (→ 401) + active-project-gated
// (→ 404), then it relays the typed JobStreamEvent frames the service yields.
// The first frame is PRIMED so a pre-stream upstream failure maps to a real HTTP
// status (404 unknown job, 502 otherwise); once frames flow the headers are
// sent, so a mid-stream failure surfaces only as a terminal `error` SSE frame.

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
  const iterator = aiExplanationService.streamExplanation(jobId)[Symbol.asyncIterator]();

  // Prime the first frame so a pre-stream transport failure (motir-ai
  // unreachable / unknown job) maps to a real HTTP status rather than a stream
  // that opens and immediately errors.
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
        while (!result.done) {
          controller.enqueue(encoder.encode(formatFrame(result.value)));
          result = await iterator.next();
        }
      } catch (err) {
        // Headers are already sent — surface the failure as a terminal SSE
        // `error` frame carrying the typed code, then close.
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
    // Client disconnect (the browser aborts the stream) → release the upstream
    // reader so we don't leak the motir-ai connection.
    async cancel() {
      await iterator.return?.(undefined);
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
