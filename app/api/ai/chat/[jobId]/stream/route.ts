import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { aiChatService } from '@/lib/services/aiChatService';
import { failureReasonFrame } from '@/lib/ai/jobStream';
import { MotirAiError, MotirAiJobNotFoundError } from '@/lib/ai/errors';
import type { JobStreamEvent } from '@/lib/ai/types';

// GET /api/ai/chat/:jobId/stream (Subtask 7.3.4) — the live channel the 7.3.5
// chat UI subscribes to. Proxies the motir-ai `discovery` job stream (7.1.5
// streamJob) to the browser as Server-Sent Events, relaying assistant-turn
// tokens + progress + the terminal status, and closing on a terminal state.
//
// Thin HTTP layer over aiChatService (CLAUDE.md 4-layer): session-gated
// (getSession → 401) + active-project-gated (getActiveProject → 404), then it
// relays the typed JobStreamEvent frames the service yields. No `db` / no
// `motir-ai` import — the boundary lives in the `server-only` client.
//
// Status mapping: the session + project gates run BEFORE the stream opens, so
// they return real HTTP codes. The upstream connection (streamJob's fetch)
// throws on its first pull, BEFORE any SSE frame, so we PRIME the first frame
// here and map a pre-stream failure to a real status too (404 unknown job, 502
// otherwise). Once frames have started flowing the headers are already sent, so
// a mid-stream upstream failure can only surface as a terminal `error` SSE
// frame carrying the typed code — never an HTTP status.

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
  const iterator = aiChatService.streamDiscovery(jobId)[Symbol.asyncIterator]();

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
        let reasonEmitted = false;
        while (!result.done) {
          controller.enqueue(encoder.encode(formatFrame(result.value)));
          // On a terminal `failed` status, append the failure REASON as an
          // `error` frame (Subtask 8.1.8) so the client learns WHY — e.g.
          // out-of-credits → the paywall — not just THAT it failed. Once only.
          if (!reasonEmitted) {
            const reason = await failureReasonFrame(jobId, result.value);
            if (reason) {
              reasonEmitted = true;
              controller.enqueue(encoder.encode(formatFrame(reason)));
            }
          }
          result = await iterator.next();
        }
      } catch (err) {
        // Headers are already sent — surface the failure as a terminal SSE
        // `error` frame carrying the typed code (mapped through the 7.1.1
        // taxonomy), then close.
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
