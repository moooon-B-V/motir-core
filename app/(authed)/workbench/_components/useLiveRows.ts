'use client';

import { useState } from 'react';
import { arrivedRowIds, mergeHeldRows, type RowId } from '@/lib/workbench/liveRows';

// WHAT A LIST SHOWS ACROSS A NUDGE (Story MOTIR-5238 · Subtask MOTIR-5242) — the
// React half of `lib/workbench/liveRows.ts`, which owns the rule itself.
//
// ⚠️ THE RESET KEY IS THE "NEXT LOAD" § 26 NAMES. The rule is that a held row
// leaves on the next LOAD — a navigation, a tab switch, a pager move, a reload —
// and NOT on a nudge. A `router.refresh()` keeps the same address, so this hook
// keeps its held rows across one; a pager move or a tab switch changes the key,
// and the list starts clean. That is the whole of the distinction between *the
// server re-read* and *the reader asked for a new view*, expressed as a string.
//
// ⚠️ IT ADJUSTS STATE DURING RENDER rather than in an effect — React's own
// pattern for deriving state from props, and the one `useRunEvents`' header
// points at when it says the modal's reset is its `useState` initializer. An
// effect here would render the stale set once, then the fresh one, which on this
// surface means a held row visibly blinking out and back.

export interface LiveRows<T> {
  /** What to render: the server's rows, plus the ones it dropped, in place. */
  rows: T[];
  /** Rows the server no longer returns — HELD, and drawn as settled. */
  heldIds: ReadonlySet<string>;
  /** Rows that arrived while the reader was looking — drawn with `New`. */
  arrivedIds: ReadonlySet<string>;
}

interface Tracked<T> {
  /** The exact props array this was derived from — identity, not contents. */
  source: readonly T[];
  resetKey: string;
  rows: T[];
  heldIds: Set<string>;
  arrivedIds: Set<string>;
}

export function useLiveRows<T>(
  incoming: readonly T[],
  resetKey: string,
  idOf: RowId<T>,
): LiveRows<T> {
  const [tracked, setTracked] = useState<Tracked<T>>(() => ({
    source: incoming,
    resetKey,
    rows: [...incoming],
    heldIds: new Set(),
    // The FIRST reading marks nothing: a reader who has just landed has had
    // nothing arrive under them (`arrivedRowIds`' own note).
    arrivedIds: new Set(),
  }));

  if (tracked.source !== incoming || tracked.resetKey !== resetKey) {
    const next: Tracked<T> =
      tracked.resetKey === resetKey
        ? {
            source: incoming,
            resetKey,
            ...mergeHeldRows(tracked.rows, incoming, idOf),
            arrivedIds: arrivedRowIds(tracked.rows, incoming, idOf),
          }
        : {
            // A LOAD. Nothing is held and nothing is new — this is a view the
            // reader asked for, so it is exactly what the server returned.
            source: incoming,
            resetKey,
            rows: [...incoming],
            heldIds: new Set(),
            arrivedIds: new Set(),
          };
    setTracked(next);
    return { rows: next.rows, heldIds: next.heldIds, arrivedIds: next.arrivedIds };
  }

  return { rows: tracked.rows, heldIds: tracked.heldIds, arrivedIds: tracked.arrivedIds };
}
