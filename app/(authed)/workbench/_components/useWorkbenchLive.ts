'use client';

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { drainSseFrames } from '@/lib/ai/sseFrames';
import { WORKBENCH_TAB_KEYS, type WorkbenchTabKey } from '@/lib/dto/workbench';

// THE WORKBENCH'S LIVE TAIL, ONCE (Story MOTIR-5238 · Subtask MOTIR-5242).
//
// ⚠️ ONE STREAM, HELD BY THE HOST — and `useRunEvents.ts`'s header is why this
// is a rule rather than a preference. That hook was LIFTED OUT of the log pane
// the moment it gained a second consumer, because two components each opening
// their own connection is *"a fan-out wearing a different name"*. This surface
// starts with more consumers than that one ended with: five lists, a strip, and
// the approval overlay. So the HOST subscribes and hands the signal down through
// {@link WorkbenchLiveContext}, and a component that calls `useWorkbenchLive`
// itself is the defect `tests/components/workbench-live.test.tsx` counts.
//
// ⚠️ IT MIRRORS `useRunEvents`, and the three differences are the story's:
//
//   · THE CURSOR IS A WATERMARK. There is no `seq` and no dedupe by id — the
//     server compares the cursor it is handed, and replaying one is harmless by
//     construction, so a reconnect needs no bookkeeping here at all.
//   · THERE IS NO TERMINAL FRAME. A run ends; a Workbench does not. `finished`
//     has no counterpart, and the stream ends when the reader leaves — which is
//     what makes the abort in the cleanup load-bearing rather than tidy.
//   · A FRAME IS A NUDGE, NOT DATA. It names which tabs moved. The surface
//     re-reads through the reads it already has, so nothing here parses a row.

/** What the host knows, and every consumer reads. */
export interface WorkbenchLive {
  /**
   * A monotonic counter of APPLIED nudges. A consumer that wants to re-read on
   * a nudge watches this rather than the tab list, because a second frame
   * naming the same tabs is a second change, not a repeat.
   */
  nudge: number;
  /** Which tabs the LAST applied frame named. Empty before the first one. */
  moved: readonly WorkbenchTabKey[];
  /** The connection dropped and is backing off. The surface says so. */
  reconnecting: boolean;
}

const QUIET: WorkbenchLive = { nudge: 0, moved: [], reconnecting: false };

/**
 * The host's signal, handed down.
 *
 * Its default is QUIET rather than `null`, so a consumer rendered outside the
 * Workbench — the approval overlay opened from an item page, say — reads a
 * surface that is simply never nudged instead of throwing. The one-connection
 * rule is about who SUBSCRIBES, and nothing is subscribed here.
 */
export const WorkbenchLiveContext = createContext<WorkbenchLive>(QUIET);

/** Read the host's stream. Safe anywhere; nudged only under the host. */
export function useWorkbenchLiveSignal(): WorkbenchLive {
  return useContext(WorkbenchLiveContext);
}

/** The stream's address — one place, so the host and its tests agree. */
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
 * The server already writes a `:` comment every {@link WORKBENCH_STREAM_HEARTBEAT_MS}
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

/**
 * SUBSCRIBE — called by the host, once.
 *
 * ⚠️ NOT EXPORTED FOR GENERAL USE, and the export that is (`useWorkbenchLiveSignal`)
 * is the read side. Anything that calls this opens a connection.
 *
 * ⚠️ `enabled` IS WHAT LETS THE HOST LIVE IN THE SHELL (Story MOTIR-5238 ·
 * MOTIR-5245's E2E finding). The provider has to sit above BOTH the Workbench
 * page and the approval overlay, because the overlay is mounted once in
 * `app/(authed)/layout.tsx` and opens over any authed page — so a provider
 * inside the Workbench page cannot reach it, and the overlay read the context's
 * QUIET default and was never nudged at all. Hoisting the provider to the shell
 * would otherwise open a connection on every authed page, which this story is
 * explicitly scoped away from ("it does not make the item page, the board, the
 * backlog or the roadmap live"). So the provider mounts everywhere and
 * SUBSCRIBES only while a surface that is live is actually on screen.
 */
export function useWorkbenchLiveStream(enabled: boolean): WorkbenchLive {
  const [live, setLive] = useState<WorkbenchLive>(QUIET);
  // The cursor the next connection presents. A ref rather than state: it changes
  // on every frame and nothing renders from it, so putting it in state would
  // re-render the whole Workbench for a string only the fetch reads.
  const cursorRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    // ⚠️ TWO CONTROLLERS, AND THE SPLIT IS LOAD-BEARING. `lifetime` is the
    // reader leaving — the effect's own cleanup, after which nothing reconnects.
    // Each CONNECTION gets its own, so the watchdog and the `offline` listener
    // can kill a dead connection without telling the pump to give up.
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
          const since = cursorRef.current;
          const url = since
            ? `${WORKBENCH_STREAM_PATH}?since=${encodeURIComponent(since)}`
            : WORKBENCH_STREAM_PATH;
          const res = await fetch(url, {
            headers: { Accept: 'text/event-stream' },
            signal: connection.signal,
          });
          if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
          if (!cancelled)
            setLive((prev) => (prev.reconnecting ? { ...prev, reconnecting: false } : prev));
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
              if (typeof frame.cursor === 'string') cursorRef.current = frame.cursor;
              const moved = Array.isArray(frame.moved) ? frame.moved.filter(isTabKey) : [];
              // ⚠️ A FRAME NAMING NOTHING IS NOT A NUDGE. The opening frame of
              // every connection carries `moved: []` — it exists to hand the
              // client its cursor — and a reconnect that missed nothing carries
              // the same. Counting those would re-read the page on every
              // reconnect, which is the cost this whole design avoids.
              if (moved.length === 0) continue;
              setLive((prev) => ({ nudge: prev.nudge + 1, moved, reconnecting: false }));
            }
          }
          if (cancelled) return;
        } catch {
          // ⚠️ THE READER LEAVING is the only abort that ends the pump. A
          // connection aborted by the watchdog or by `offline` is a DROP, and a
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
        setLive((prev) => (prev.reconnecting ? prev : { ...prev, reconnecting: true }));
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
    // ⚠️ `enabled` IS THE ONLY DEP, and a flip RE-OPENS from the cursor the ref
    // still holds — neither a replay nor a gap, which is the whole point of a
    // watermark. Closing the connection when the last live surface leaves the
    // screen is the same discipline as the abort in the cleanup.
  }, [enabled]);

  return live;
}
