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

function isTabKey(value: unknown): value is WorkbenchTabKey {
  return typeof value === 'string' && (WORKBENCH_TAB_KEYS as readonly string[]).includes(value);
}

/**
 * SUBSCRIBE — called by the host, once.
 *
 * ⚠️ NOT EXPORTED FOR GENERAL USE, and the export that is (`useWorkbenchLiveSignal`)
 * is the read side. Anything that calls this opens a connection.
 */
export function useWorkbenchLiveStream(): WorkbenchLive {
  const [live, setLive] = useState<WorkbenchLive>(QUIET);
  // The cursor the next connection presents. A ref rather than state: it changes
  // on every frame and nothing renders from it, so putting it in state would
  // re-render the whole Workbench for a string only the fetch reads.
  const cursorRef = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    const pump = async (): Promise<void> => {
      for (let attempt = 0; !cancelled; attempt += 1) {
        try {
          const since = cursorRef.current;
          const url = since
            ? `${WORKBENCH_STREAM_PATH}?since=${encodeURIComponent(since)}`
            : WORKBENCH_STREAM_PATH;
          const res = await fetch(url, {
            headers: { Accept: 'text/event-stream' },
            signal: controller.signal,
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
          if (cancelled || controller.signal.aborted) return;
        }
        if (cancelled) return;
        // The connection dropped. Say so, then resume FROM THE WATERMARK — which
        // is neither a replay nor a gap, because the server compares the cursor
        // rather than replaying from a position.
        setLive((prev) => (prev.reconnecting ? prev : { ...prev, reconnecting: true }));
        const backoff = Math.min(1_000 * 2 ** Math.min(attempt, 4), BACKOFF_CEILING_MS);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    };

    void pump();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  return live;
}
