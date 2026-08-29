import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { DispatchRunNotFoundError } from '@/lib/dispatchRuns/errors';
import type { DispatchRunEventDto } from '@/lib/dto/dispatchRuns';
import { dispatchRunService } from '@/lib/services/dispatchRunService';

// GET /api/dispatch-runs/[id]/stream (Story MOTIR-1789 · MOTIR-1793) — the LIVE
// TAIL of one run's event stream, as Server-Sent Events.
//
// ⚠️ THIS MIRRORS `app/api/ai/plan/generate/[jobId]/stream/route.ts` — the frame
// format (`event:` + `data:` JSON through a local `formatFrame`), the
// `SSE_HEADERS` set, the gate-BEFORE-the-stream-opens ordering (so a session or
// tenancy refusal is a real HTTP status and no frame is ever written to a caller
// who may not read the run), and the `cancel()` that releases on client
// disconnect. It was read before this route was written, and it is cited here
// because a SECOND streaming convention in one codebase means two heartbeat
// intervals, two frame formats, and two sets of proxy-timeout bugs to learn
// about separately.
//
// ── WHERE IT NECESSARILY DIFFERS, and why ─────────────────────────────────
// That route RELAYS an upstream iterator motir-ai owns, so it primes the first
// frame to map a transport failure to a status. This one has no upstream: the
// events are rows in this database, so the stream POLLS its own service. The
// `?since=<seq>` cursor is what makes that safe — the `@@unique([dispatchRunId,
// seq])` on the schema is exactly the guarantee a resuming client needs, and it
// is why a reconnect replays from where it dropped rather than from zero (a
// duplicate) or from now (a gap).

/** Serialise one event as an SSE frame — the shipped format, unchanged. */
function formatFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
} as const;

/** How often the stream asks its service for new events. */
export const DISPATCH_RUN_STREAM_POLL_MS = 1_000;

/**
 * How often a silent stream writes a comment frame.
 *
 * A run can be quiet for minutes — an agent is thinking, or CI is running — and
 * an idle connection is exactly what a proxy in front of the app closes. The
 * heartbeat is a `:` comment rather than an event, so a client's `EventSource`
 * handlers never see it and no consumer has to learn to ignore it.
 */
export const DISPATCH_RUN_STREAM_HEARTBEAT_MS = 15_000;

/** One page of events per poll — bounded so a long backlog drains in frames. */
const PAGE = 200;

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { id } = await params;
  const sinceParam = Number(new URL(req.url).searchParams.get('since'));
  // A missing, negative or unparseable cursor means "from the beginning". `0` is
  // the same thing said explicitly, which is why the cursor is a NUMBER on the
  // wire and never null: a client that has seen nothing and one resuming from
  // event 400 make the same call.
  const since = Number.isFinite(sinceParam) && sinceParam > 0 ? Math.floor(sinceParam) : 0;

  // The FIRST page is read before the stream opens, so an unknown or
  // cross-workspace run is a real 404 rather than a stream that opens and
  // immediately errors. This is the shipped route's "prime the first frame"
  // ordering, applied to the read this route actually makes.
  let first: { events: DispatchRunEventDto[]; status: string };
  try {
    first = await dispatchRunService.readStreamPage(id, since, PAGE, ctx);
  } catch (err) {
    if (err instanceof DispatchRunNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }

  const encoder = new TextEncoder();
  // Set by `cancel()` when the browser closes its `EventSource`. Hoisted out of
  // `start` so the poll loop can SEE it: without this the loop keeps waking every
  // second, re-reading the database for a reader who has gone — the same leak the
  // shipped route's `cancel()` closes, in the shape a polling stream needs.
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let cursor = since;
      let closed = false;
      let lastWrite = Date.now();

      const write = (frame: string): void => {
        controller.enqueue(encoder.encode(frame));
        lastWrite = Date.now();
      };

      const emit = (page: { events: DispatchRunEventDto[]; status: string }): boolean => {
        for (const event of page.events) {
          write(formatFrame('event', event));
          cursor = event.seq;
        }
        // ⚠️ THE STATUS IS EMITTED AFTER THE EVENTS OF THE SAME PAGE, and the
        // service read both in ONE transaction — so a terminal status can never
        // close the stream on top of events that were already committed.
        if (TERMINAL.has(page.status)) {
          write(formatFrame('done', { status: page.status, seq: cursor }));
          return true;
        }
        return false;
      };

      try {
        // An ALREADY-TERMINAL run replays from the cursor and closes rather than
        // holding a connection open: there is nothing further to wait for, and a
        // parked connection on a finished run is a socket a proxy will eventually
        // reap anyway.
        if (emit(first)) return;

        while (!closed && !cancelled) {
          await new Promise((resolve) => setTimeout(resolve, DISPATCH_RUN_STREAM_POLL_MS));
          if (closed || cancelled) break;
          const page = await dispatchRunService.readStreamPage(id, cursor, PAGE, ctx);
          if (emit(page)) return;
          if (Date.now() - lastWrite >= DISPATCH_RUN_STREAM_HEARTBEAT_MS) {
            write(': heartbeat\n\n');
          }
        }
      } catch (err) {
        // Headers are already sent, so a mid-stream failure can only surface as a
        // terminal `error` frame — the shipped route's contract, unchanged.
        const message = err instanceof Error ? err.message : 'stream failed';
        controller.enqueue(
          encoder.encode(formatFrame('error', { code: 'INTERNAL_ERROR', message })),
        );
      } finally {
        closed = true;
        // A controller whose stream was CANCELLED is already closed; closing it
        // again throws, and a throw here would be an unhandled rejection on a
        // disconnect — the most ordinary event in a stream's life.
        if (!cancelled) controller.close();
      }
    },
    cancel() {
      cancelled = true;
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
