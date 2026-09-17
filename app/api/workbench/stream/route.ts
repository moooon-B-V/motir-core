import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { projectsService } from '@/lib/services/projectsService';
import { workbenchWatermarkService } from '@/lib/services/workbenchWatermarkService';
import type { WorkbenchWatermarkDto } from '@/lib/dto/workbench';

// GET /api/workbench/stream (Story MOTIR-5238 · MOTIR-5241) — the Workbench's
// LIVE TAIL, as Server-Sent Events.
//
// ⚠️ THIS MIRRORS `app/api/dispatch-runs/[id]/stream/route.ts`, which mirrors
// `app/api/ai/plan/generate/[jobId]/stream/route.ts` before it. That route's own
// header states the reason and it is copied here rather than re-derived: *"a
// SECOND streaming convention in one codebase means two heartbeat intervals, two
// frame formats, and two sets of proxy-timeout bugs to learn about
// separately."* What is identical: the frame format (`event:` + `data:` JSON
// through a local `formatFrame`), the `SSE_HEADERS` set, the
// gate-BEFORE-the-stream-opens ordering, the `:` comment heartbeat, the poll
// interval as a named exported constant, and a `cancel()` that sets a flag the
// poll loop can SEE.
//
// ── WHERE IT NECESSARILY DIFFERS, and each difference is a decision ─────────
//
// THE CURSOR IS A WATERMARK, NOT A SEQUENCE. A run resumes from `seq` on an
// append-only table, and `@@unique([dispatchRunId, seq])` is the guarantee that
// makes a reconnect neither a replay nor a gap. The Workbench has no such table
// and this story adds none. What replaces that guarantee is IDEMPOTENCE BY
// CONSTRUCTION: the cursor names a STATE rather than a position, the frame
// carries an INVALIDATION rather than data, and the client re-reads whatever the
// frame names — so replaying a cursor costs a redundant read and can never
// produce a duplicate row. A reader looking here for the run stream's uniqueness
// guarantee should find this paragraph instead.
//
// THERE IS NO TERMINAL STATE. A run ends; a Workbench does not. So there is no
// `done` frame and the stream runs until the reader leaves — which makes
// `cancel()` load-bearing here in a way it is not there. Without it the loop
// keeps waking every second and re-reading the database for somebody who has
// closed the tab, and nothing would ever stop it.
//
// THE FRAME CARRIES NO CONTENT — which tabs moved, and the new cursor. Nothing
// else. A reader therefore receives nothing their own reads would not return,
// and the access decision stays in those reads rather than being made a second
// time here.
//
// AND IT KEEPS NO PER-CONNECTION STATE BEYOND THE CURSOR. A route that remembers
// what it has sent is a route that is wrong after a redeploy, and wrong
// per-connection rather than visibly.

/** Serialise one event as an SSE frame — the shipped format, unchanged. */
function formatFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
} as const;

/**
 * How often the stream asks the watermark read whether anything moved.
 *
 * The same number as `DISPATCH_RUN_STREAM_POLL_MS`, and exported for the same
 * reason: the tests and any future client read ONE number rather than two that
 * drift.
 */
export const WORKBENCH_STREAM_POLL_MS = 1_000;

/**
 * How often a silent stream writes a comment frame.
 *
 * A Workbench can be quiet for hours — most of them are, most of the time — and
 * an idle connection is exactly what a proxy in front of the app closes. The
 * heartbeat is a `:` comment rather than an event, so a client's frame parser
 * never surfaces it and no consumer has to learn to ignore it.
 */
export const WORKBENCH_STREAM_HEARTBEAT_MS = 15_000;

/** The frame this route writes. Named so the client and the tests agree on it. */
export const WORKBENCH_STREAM_FRAME = 'watermark';

/** What a frame carries: which tabs moved, and the cursor to present next time. */
export interface WorkbenchStreamFrame {
  moved: WorkbenchWatermarkDto['moved'];
  cursor: string;
}

export async function GET(req: Request): Promise<Response> {
  // ⚠️ THE GATE RUNS BEFORE ANYTHING IS WRITTEN. A session, 2FA-hold or
  // tenancy refusal is a real HTTP status with a JSON body, so no frame is ever
  // written to a reader who may not see the data — the shipped route's ordering,
  // and the reason it is an ordering rather than a check.
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  // The reader's ACTIVE project, resolved through the same service the Workbench
  // page resolves it through. A reader with none is answered with a status
  // rather than an empty stream: unreachable for a signed-in member (MOTIR-4870
  // seeds a default project at the workspace tier), and a stream that opened and
  // then said nothing for ever would be the worst way to express it.
  const project = await projectsService.getActiveProject(ctx.userId, ctx.workspaceId);
  if (!project) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project for this reader.' },
      { status: 404 },
    );
  }
  const actor = { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: project.id };

  const since = new URL(req.url).searchParams.get('since');

  // The FIRST read happens BEFORE the stream is constructed, so a failure in it
  // is a real status rather than a stream that opens and immediately errors.
  // This is the shipped route's "prime the first frame" ordering applied to the
  // read this one actually makes.
  const first = await workbenchWatermarkService.read(actor, since);

  const encoder = new TextEncoder();
  // Set by `cancel()` when the browser drops the connection. Hoisted out of
  // `start` so the poll loop can SEE it — without this the loop keeps waking
  // every second for a reader who has gone, and here there is no terminal state
  // to end it instead.
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let cursor = first.cursor;
      let closed = false;
      let lastWrite = Date.now();

      const write = (frame: string): void => {
        controller.enqueue(encoder.encode(frame));
        lastWrite = Date.now();
      };

      const emit = (reading: WorkbenchWatermarkDto): void => {
        cursor = reading.cursor;
        write(formatFrame(WORKBENCH_STREAM_FRAME, { moved: reading.moved, cursor }));
      };

      try {
        // ⚠️ THE OPENING FRAME IS WRITTEN EVEN WHEN NOTHING MOVED, and that is
        // what makes a reconnect work at all: it is how a client LEARNS the
        // cursor it will present next time. It carries `moved: []` for a reader
        // who presented no cursor and for one whose cursor is current, so a
        // reconnect that has missed nothing asks the client to do nothing.
        emit(first);

        while (!closed && !cancelled) {
          await new Promise((resolve) => setTimeout(resolve, WORKBENCH_STREAM_POLL_MS));
          if (closed || cancelled) break;
          const reading = await workbenchWatermarkService.read(actor, cursor);
          // A frame ONLY when something moved. A quiet Workbench costs a
          // heartbeat every fifteen seconds and nothing else.
          if (reading.moved.length > 0) emit(reading);
          else cursor = reading.cursor;
          if (Date.now() - lastWrite >= WORKBENCH_STREAM_HEARTBEAT_MS) {
            write(': heartbeat\n\n');
          }
        }
      } catch (err) {
        // Headers are already sent, so a mid-stream failure can only surface as
        // a terminal `error` frame — the shipped route's contract, unchanged.
        const message = err instanceof Error ? err.message : 'stream failed';
        controller.enqueue(
          encoder.encode(formatFrame('error', { code: 'INTERNAL_ERROR', message })),
        );
      } finally {
        closed = true;
        // A controller whose stream was CANCELLED is already closed; closing it
        // again throws, and a throw here would be an unhandled rejection on a
        // disconnect — the most ordinary event in this stream's life, since a
        // disconnect is the ONLY way it ever ends.
        if (!cancelled) controller.close();
      }
    },
    cancel() {
      cancelled = true;
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
