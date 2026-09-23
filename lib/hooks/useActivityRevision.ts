'use client';

import { useSyncExternalStore } from 'react';

/**
 * The item page's ACTIVITY REFETCH SIGNAL (Story MOTIR-6016 · MOTIR-6101) — the
 * provider tick `motir-core/CLAUDE.md`'s page-state-after-mutation contract
 * prescribes for a client island `router.refresh()` cannot reach.
 *
 * The History and All sections are islands seeded ONCE from their server
 * `initialPage`, and the core-fields panel keeps its optimistic value with no
 * refresh (the inline-edit rule). So a field edit wrote its revision and the
 * feed never showed it until a reload. A successful save now calls
 * {@link bumpActivity}; each section watches {@link useActivityRevision} and
 * re-reads its first page when the number moves.
 *
 * A module-level store keyed by work-item id, read through
 * `useSyncExternalStore` (the `useCommentsSort` pattern): no provider to mount,
 * and the server snapshot is always 0, so hydration never mismatches.
 */

const listeners = new Set<() => void>();
const revisions = new Map<string, number>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tell every activity island for this work item that a change was recorded. */
export function bumpActivity(workItemId: string): void {
  revisions.set(workItemId, (revisions.get(workItemId) ?? 0) + 1);
  for (const listener of listeners) listener();
}

/** A monotonic number that moves each time {@link bumpActivity} runs for the item. */
export function useActivityRevision(workItemId: string): number {
  return useSyncExternalStore(
    subscribe,
    () => revisions.get(workItemId) ?? 0,
    () => 0,
  );
}
