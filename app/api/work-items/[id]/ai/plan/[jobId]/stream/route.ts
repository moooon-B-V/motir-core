import { NextResponse } from 'next/server';

import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { contextualPlanningService } from '@/lib/services/contextualPlanningService';
import { failureReasonFrame } from '@/lib/ai/jobStream';
import { MotirAiError, MotirAiJobNotFoundError } from '@/lib/ai/errors';
import type { JobStreamEvent } from '@/lib/ai/types';
import { mapContextualPlanError, noActiveProject } from '../../_errors';

// GET /api/work-items/[id]/ai/plan/[jobId]/stream — relay a contextual planning
// job's progress to the embedded panel as SSE (7.12.3 · MOTIR-909).
//
// Browsers stream from CORE, never from motir-ai (the open-core invariant): the
// motir-ai client is `server-only`, so this route is structurally the only way
// the events reach a browser. On terminal, the proposed delta rides the job
// RESULT, which the shipped job route reads — this channel carries progress.
//
// The anchor is re-gated on subscribe. A separate request is a separate
// authorization: a permission that held when the turn was submitted is not
// evidence it still holds now, and an SSE connection is long-lived.
//
// Shape mirrors the shipped `/api/ai/augment/[jobId]/stream`: pull the FIRST
// event before returning, so a transport failure becomes a real HTTP status
// instead of a 200 whose body immediately errors; then the ROUTE owns the
// iterator so a client disconnect cancels it promptly.
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
  { params }: { params: Promise<{ id: string; jobId: string }> },
): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();

  const { id, jobId } = await params;

  let generator: AsyncGenerator<JobStreamEvent>;
  try {
    generator = await contextualPlanningService.streamPlanJob(id, jobId, ctx);
  } catch (err) {
    const mapped = mapContextualPlanError(err);
    if (mapped) return mapped;
    throw err;
  }

  const iterator = generator[Symbol.asyncIterator]();

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
            const reason = await failureReasonFrame(jobId, result.value);
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
