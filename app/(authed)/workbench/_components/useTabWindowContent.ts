'use client';

import { createContext, useContext, useState } from 'react';
import type { WorkbenchApprovalsWindowDto, WorkbenchPlanningWindowDto } from '@/lib/dto/workbench';

// TO APPROVE AND PLANNING, APPLIED IN PLACE (Story MOTIR-8539 · Subtask MOTIR-8581).
//
// ⚠️ ONE READ PATH, NOT A SECOND ONE. `<WorkbenchLiveView>` owns the Workbench's
// one `useWorkbenchWindow` — the hook that reads `GET /api/workbench/window` on a
// nudge and sets the strip's counts. On these two tabs the answer's window is the
// gate queue or the planning page, and the view publishes it here, beside its
// `reread`. The two lists are server-seeded client islands under the page's
// `<Suspense>`, so they cannot be handed it as props; they read it from this
// context instead.
//
// ⚠️ ROWS AND COUNTS LAND IN ONE COMMIT. The view sets the counts and the window
// in ONE state update, and a list derives its content from the window DURING
// RENDER (React's pattern for state derived from props, `useLiveRows`' too) —
// never in an effect, which would paint the new counts over the old rows once.
//
// ⚠️ AN EQUAL ANSWER CHANGES NOTHING. The view keeps the previous window object
// when the answer is structurally equal, so the context value does not move and
// no list re-renders; and `merge` keeps every unchanged row's object, so a changed
// answer re-renders only the rows it changed.

export type WorkbenchTabWindowDto = WorkbenchApprovalsWindowDto | WorkbenchPlanningWindowDto;

export interface WorkbenchTabWindowValue {
  /** The last window read for To approve or Planning — `null` before the first read. */
  window: WorkbenchTabWindowDto | null;
  /** Read now, through the view's one hook. */
  reread: () => void;
  /** Consecutive reads that failed. */
  failures: number;
}

const NO_REREAD = () => {};

const NOTHING_READ: WorkbenchTabWindowValue = { window: null, reread: NO_REREAD, failures: 0 };

export const WorkbenchTabWindowContext = createContext<WorkbenchTabWindowValue>(NOTHING_READ);

interface Tracked<T> {
  /** The window this content was last derived from. */
  window: WorkbenchTabWindowDto | null;
  /** The server props it was seeded from. */
  seed: T;
  content: T;
}

/**
 * A tab's content: the server's first paint, then every window the view reads for
 * `kind`, merged over what is held (`merge` returns `prev` itself when nothing changed).
 */
export function useTabWindowContent<K extends WorkbenchTabWindowDto['kind'], T>(
  kind: K,
  seed: T,
  fromWindow: (window: Extract<WorkbenchTabWindowDto, { kind: K }>) => T,
  merge: (prev: T, next: T) => T,
): { content: T; reread: () => void; failures: number } {
  const live = useContext(WorkbenchTabWindowContext);
  const [tracked, setTracked] = useState<Tracked<T>>(() => ({
    window: live.window,
    seed,
    content: seed,
  }));

  let current = tracked;
  if (tracked.seed !== seed) {
    // The server rendered this tab again (a navigation back onto it): merged, like a read.
    current = { ...current, seed, content: merge(current.content, seed) };
  }
  if (current.window !== live.window) {
    const content =
      live.window !== null && live.window.kind === kind
        ? merge(
            current.content,
            fromWindow(live.window as Extract<WorkbenchTabWindowDto, { kind: K }>),
          )
        : current.content;
    current = { ...current, window: live.window, content };
  }
  if (current !== tracked) setTracked(current);

  return { content: current.content, reread: live.reread, failures: live.failures };
}
