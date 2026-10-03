import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { mapAgentInstanceError } from '@/lib/agentInstances/errorResponse';
import type { AgentInstanceBootDto, AgentInstanceBootStepFrameDto } from '@/lib/dto/agentInstances';
import { agentInstanceBootService } from '@/lib/services/agentInstanceBootService';

// GET `/api/projects/:key/instances/:id/boot/stream?since=<seq>` — an agent's boot,
// LIVE, as Server-Sent Events (Story MOTIR-7393 · MOTIR-7399, `agent-instances.md`
// AMENDMENT 6 §7).
//
// ⚠️ THIS MIRRORS `app/api/dispatch-runs/[id]/stream/route.ts`: the frame format
// through a local `formatFrame`, the `SSE_HEADERS`, the gate BEFORE the stream
// opens (a refusal is an ordinary JSON 4xx and no frame is ever written to a
// caller who may not read the agent), the 1-second poll of its SERVICE (never the
// database), the 15-second `:` heartbeat, and the `cancel()` that stops the poll.
//
// ── FRAMES ──────────────────────────────────────────────────────────────────
//   `snapshot` — the whole current attempt, once at open and again whenever a new
//                attempt begins (a wake after the stream opened);
//   `step`     — one per step written after the cursor, with its `seq` and attempt;
//   `done`     — `{ state }`, the attempt's outcome, once it has closed; then the
//                stream closes.
// Every step write stamps a new per-agent `seq`, so `?since=<seq>` resumes a
// dropped connection with exactly the steps it missed — no gap, no duplicate.

/** Serialise one event as an SSE frame — the shipped format, unchanged. */
function formatFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
} as const;

/** How often the stream asks its service for new steps. */
export const AGENT_BOOT_STREAM_POLL_MS = 1_000;

/** How often a silent stream writes a `:` comment, so a proxy keeps it open. */
export const AGENT_BOOT_STREAM_HEARTBEAT_MS = 15_000;

/** The stream's clock and timer — a seam a test drives instead of waiting. */
export const agentBootStreamClock = {
  now: (): number => Date.now(),
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};

type Page = { boot: AgentInstanceBootDto | null; changed: AgentInstanceBootStepFrameDto[] };

export async function GET(
  req: Request,
  { params }: { params: Promise<{ key: string; id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;
  const { key, id } = await params;
  const sinceParam = Number(new URL(req.url).searchParams.get('since'));
  const since = Number.isFinite(sinceParam) && sinceParam > 0 ? Math.floor(sinceParam) : 0;

  // The FIRST read happens before the stream opens, so a refusal is a real status.
  let first: Page;
  try {
    first = await agentInstanceBootService.readBootSince(key, id, since, ctx);
  } catch (err) {
    const mapped = mapAgentInstanceError(err);
    if (mapped) return mapped;
    throw err;
  }

  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let cursor = since;
      let attempt: number | null = null;
      let lastWrite = agentBootStreamClock.now();

      const write = (frame: string): void => {
        controller.enqueue(encoder.encode(frame));
        lastWrite = agentBootStreamClock.now();
      };

      /** Send what this page carries; true once the attempt has closed. */
      const emit = (page: Page, initial: boolean): boolean => {
        if (!page.boot) return false;
        if (page.boot.attempt !== attempt) {
          attempt = page.boot.attempt;
          write(formatFrame('snapshot', page.boot));
          // A fresh snapshot carries every step, so the cursor moves past them.
          cursor = Math.max(cursor, page.boot.seq);
        } else {
          for (const step of page.changed) {
            write(formatFrame('step', step));
            cursor = Math.max(cursor, step.seq);
          }
        }
        if (initial && since > 0) {
          // A resuming client already has the attempt: it is owed the steps after
          // its cursor, which the snapshot above does not single out.
          for (const step of page.changed) write(formatFrame('step', step));
        }
        if (page.boot.outcome) {
          write(formatFrame('done', { state: page.boot.outcome, seq: cursor }));
          return true;
        }
        return false;
      };

      try {
        if (emit(first, true)) return;
        while (!cancelled) {
          await agentBootStreamClock.sleep(AGENT_BOOT_STREAM_POLL_MS);
          if (cancelled) break;
          const page = await agentInstanceBootService.readBootSince(key, id, cursor, ctx, true);
          if (cancelled) break;
          if (emit(page, false)) return;
          if (agentBootStreamClock.now() - lastWrite >= AGENT_BOOT_STREAM_HEARTBEAT_MS) {
            write(': heartbeat\n\n');
          }
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : 'stream failed';
          controller.enqueue(
            encoder.encode(formatFrame('error', { code: 'INTERNAL_ERROR', message })),
          );
        }
      } finally {
        if (!cancelled) controller.close();
      }
    },
    cancel() {
      cancelled = true;
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
