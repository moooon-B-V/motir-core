'use client';

import { createContext, useContext, useMemo, useState } from 'react';
import type { WorkbenchTabKey } from '@/lib/dto/workbench';
import { useLiveReconnecting, useLiveSignal } from '@/lib/live/liveSignal';

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

// ⚠️ THE CONNECTION LIVES BEHIND THE SEAM NOW (Story MOTIR-8539 · Subtask
// MOTIR-8572): `lib/live/sources/workbenchStreamSource.ts` holds it, unchanged,
// and this file reads it through `useLiveSignal`. The two constants are
// re-exported from here so every existing reader keeps its import.
export { STREAM_STALE_MS, WORKBENCH_STREAM_PATH } from '@/lib/live/sources/workbenchStreamSource';

/** The one topic the Workbench reads. */
const WORKBENCH_TOPIC = { kind: 'workbench' } as const;

/**
 * SUBSCRIBE — called by the host, once.
 *
 * ⚠️ NOT EXPORTED FOR GENERAL USE, and the export that is (`useWorkbenchLiveSignal`)
 * is the read side. Subscribing is what makes the source hold its connection.
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
 *
 * It must be called under the `LiveSignalProvider` that carries the workbench
 * source (`WorkbenchLive` mounts both); under none, the topic is QUIET.
 */
export function useWorkbenchLiveStream(enabled: boolean): WorkbenchLive {
  const [applied, setApplied] = useState<{ nudge: number; moved: readonly WorkbenchTabKey[] }>({
    nudge: 0,
    moved: [],
  });
  useLiveSignal(
    WORKBENCH_TOPIC,
    (signal) => setApplied((prev) => ({ nudge: prev.nudge + 1, moved: signal.moved ?? [] })),
    { enabled },
  );
  const reconnecting = useLiveReconnecting();
  return useMemo(
    () => ({ nudge: applied.nudge, moved: applied.moved, reconnecting }),
    [applied, reconnecting],
  );
}
