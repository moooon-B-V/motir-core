import { drainSseFrames } from '@/lib/ai/sseFrames';
import { WORKBENCH_TAB_KEYS, type WorkbenchTabKey } from '@/lib/dto/workbench';
import { createLiveFlag } from '../liveFlag';
import type { LiveSignalListener, LiveSignalSource } from '../liveSignal';

// THE WORKBENCH'S SSE NUDGE, AS A SOURCE (Story MOTIR-8539 · Subtask MOTIR-8572).
//
// The connection logic is `useWorkbenchLiveStream`'s from Story MOTIR-5238
// (Subtask MOTIR-5242), moved here unchanged so it can sit behind the seam: the
// watermark cursor, the backoff to a 15s ceiling, the `STREAM_STALE_MS`
// watchdog, the `offline` / `online` listeners and the frame filter. What is
// new is only WHO it answers: subscribers by topic instead of one hook's state.
//
// ⚠️ ONE CONNECTION PER SOURCE, HOWEVER MANY SUBSCRIBERS. It connects when the
// first `workbench` subscriber arrives and closes when the last one leaves — the
// same discipline as the hook's `enabled` gate, counted instead of passed. The
// cursor outlives the connection, so a reopen resumes from the watermark:
// neither a replay nor a gap. The shell's provider holds the one source.
//
// ⚠️ A FRAME NAMING NOTHING IS NOT A SIGNAL. The opening frame of every
// connection carries `moved: []` to hand the client its cursor, and a reconnect
// that missed nothing carries the same. Signalling those would re-read on every
// reconnect, which is the cost this design avoids.

/** The stream's address — one place, so the source and its tests agree. */
export const WORKBENCH_STREAM_PATH = '/api/workbench/stream';

/** The backoff ceiling, matching `useRunEvents`' — one number, one behaviour. */
const BACKOFF_CEILING_MS = 15_000;

/**
 * No bytes for this long means the connection is DEAD, whatever the socket says
 * (Story MOTIR-5238 · MOTIR-5245's E2E finding).
 *
 * ⚠️ A DROPPED CONNECTION DOES NOT ALWAYS FAIL, and that is the whole reason this
 * exists. Measured in the acceptance lane: with the browser taken offline mid-walk,
 * every NEW request failed `ERR_INTERNET_DISCONNECTED` while the already-open
 * stream was never torn down at all — no error, no `done`, no event. The reader
 * sat in front of a page that looked live and was frozen, and `reconnecting` —
 * the one thing the design promises them (§ 26, Panel 2) — never came, because
 * nothing had gone wrong in any way the client could see.
 *
 * The server already writes a `:` comment every `WORKBENCH_STREAM_HEARTBEAT_MS`
 * of silence so a proxy does not close the connection. That makes SILENCE itself
 * measurable: a healthy connection delivers bytes at least that often, so a gap of
 * more than two heartbeats is a connection that has stopped existing. The heartbeat
 * was already paying for this; it just had no reader.
 *
 * Two heartbeats plus slack, rather than one: a single missed beat is a slow
 * network, and announcing a drop that has not happened teaches a reader to ignore
 * the one that has.
 */
export const STREAM_STALE_MS = 35_000;

/** How often the watchdog looks. Cheap, and never the thing that decides. */
const WATCHDOG_TICK_MS = 2_000;

function isTabKey(value: unknown): value is WorkbenchTabKey {
  return typeof value === 'string' && (WORKBENCH_TAB_KEYS as readonly string[]).includes(value);
}

export interface WorkbenchStreamSource extends LiveSignalSource {
  /** Close the connection now (the holder unmounted). A later subscribe reopens it. */
  dispose(): void;
}

export function createWorkbenchStreamSource(): WorkbenchStreamSource {
  const listeners = new Set<LiveSignalListener>();
  const reconnecting = createLiveFlag(false);
  // The cursor the next connection presents. It outlives every connection.
  let cursor: string | null = null;
  let seq = 0;
  // The running pump's stop, or null when no connection is held.
  let stopPump: (() => void) | null = null;

  const signal = (moved: WorkbenchTabKey[]): void => {
    seq += 1;
    const next = { topic: { kind: 'workbench' as const }, seq, moved };
    for (const listener of [...listeners]) listener(next);
  };

  const startPump = (): (() => void) => {
    // ⚠️ TWO CONTROLLERS, AND THE SPLIT IS LOAD-BEARING. `lifetime` is the last
    // subscriber leaving, after which nothing reconnects. Each CONNECTION gets
    // its own, so the watchdog and the `offline` listener can kill a dead
    // connection without telling the pump to give up.
    const lifetime = new AbortController();
    let cancelled = false;

    const pump = async (): Promise<void> => {
      for (let attempt = 0; !cancelled; attempt += 1) {
        const connection = new AbortController();
        const dropConnection = (): void => connection.abort();
        lifetime.signal.addEventListener('abort', dropConnection);
        // A browser that KNOWS it is offline says so at once, rather than waiting
        // out the watchdog: the reader is told in the moment the lift stops.
        window.addEventListener('offline', dropConnection);
        let lastByteAt = Date.now();
        const watchdog = setInterval(() => {
          if (Date.now() - lastByteAt >= STREAM_STALE_MS) dropConnection();
        }, WATCHDOG_TICK_MS);
        try {
          const since = cursor;
          const url = since
            ? `${WORKBENCH_STREAM_PATH}?since=${encodeURIComponent(since)}`
            : WORKBENCH_STREAM_PATH;
          const res = await fetch(url, {
            headers: { Accept: 'text/event-stream' },
            signal: connection.signal,
          });
          if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
          if (!cancelled) reconnecting.set(false);
          // A connection that opened resets the backoff: the next drop is a
          // first drop, not the fifth.
          attempt = 0;

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done || cancelled) break;
            // EVERY byte counts, a heartbeat's included — the watchdog is
            // measuring silence, not events.
            lastByteAt = Date.now();
            buffer += decoder.decode(value, { stream: true });
            const { frames, rest } = drainSseFrames(buffer);
            buffer = rest;
            for (const { data } of frames) {
              const frame = data as { moved?: unknown; cursor?: unknown };
              if (typeof frame.cursor === 'string') cursor = frame.cursor;
              const moved = Array.isArray(frame.moved) ? frame.moved.filter(isTabKey) : [];
              if (moved.length === 0) continue;
              reconnecting.set(false);
              signal(moved);
            }
          }
          if (cancelled) return;
        } catch {
          // ⚠️ THE LAST SUBSCRIBER LEAVING is the only abort that ends the pump.
          // A connection aborted by the watchdog or by `offline` is a DROP, and a
          // drop is what this loop exists to survive.
          if (cancelled || lifetime.signal.aborted) return;
        } finally {
          clearInterval(watchdog);
          lifetime.signal.removeEventListener('abort', dropConnection);
          window.removeEventListener('offline', dropConnection);
        }
        if (cancelled) return;
        // The connection dropped. Say so, then resume FROM THE WATERMARK — which
        // is neither a replay nor a gap, because the server compares the cursor
        // rather than replaying from a position.
        reconnecting.set(true);
        const backoff = Math.min(1_000 * 2 ** Math.min(attempt, 4), BACKOFF_CEILING_MS);
        // ⚠️ THE BACKOFF IS INTERRUPTED BY `online`. Waiting out fifteen seconds
        // after the network has visibly come back is a stale page the reader can
        // SEE is stale, and it is the half of a drop they remember.
        await new Promise<void>((resolve) => {
          const wake = (): void => {
            clearTimeout(timer);
            window.removeEventListener('online', wake);
            resolve();
          };
          const timer = setTimeout(wake, backoff);
          window.addEventListener('online', wake, { once: true });
        });
      }
    };

    void pump();
    return () => {
      cancelled = true;
      lifetime.abort();
    };
  };

  const stop = (): void => {
    stopPump?.();
    stopPump = null;
    // Nothing is connected, so nothing is reconnecting.
    reconnecting.set(false);
  };

  return {
    subscribe(topic, onSignal) {
      if (topic.kind !== 'workbench') return () => {};
      const listener: LiveSignalListener = (s) => onSignal(s);
      listeners.add(listener);
      if (!stopPump) stopPump = startPump();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
    reconnecting,
    dispose: stop,
  };
}
