'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * useCollapsedLanes — per-board, persisted swimlane collapse state (Subtask
 * 3.3.5). Which lanes a user has collapsed is client-only UI state that must
 * survive reloads (the design's "collapsed lanes persist client-side"), so it
 * lives in localStorage keyed by board.
 *
 * Recipe mirrors `useSidebarCollapsed` / `theme-context`: the value is read
 * LAZILY from localStorage on first snapshot (no flash, no set-state-in-effect)
 * and changes flow through `useSyncExternalStore` — the React-blessed primitive
 * for an external store + the cross-tab `storage` event — never `useEffect` +
 * `setState`. The snapshot is a cached, referentially-stable `Set` so React's
 * snapshot comparison doesn't loop.
 *
 * Persisted under `motir.board.collapsedLanes.<boardId>` (a JSON array of the
 * collapsed lane keys), in the shared `motir.*` namespace. Default: none
 * collapsed (every lane expanded).
 */
export const COLLAPSED_LANES_STORAGE_PREFIX = 'motir.board.collapsedLanes.';

const EMPTY: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
/** Per-board cached snapshot; `undefined` until the first lazy read. */
const cache = new Map<string, ReadonlySet<string>>();

function storageKey(boardId: string): string {
  return COLLAPSED_LANES_STORAGE_PREFIX + boardId;
}

function readInitial(boardId: string): ReadonlySet<string> {
  if (typeof window === 'undefined') return EMPTY;
  try {
    const raw = window.localStorage.getItem(storageKey(boardId));
    if (!raw) return EMPTY;
    const arr = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(arr) ? (arr as string[]) : []);
  } catch {
    return EMPTY;
  }
}

function snapshot(boardId: string): ReadonlySet<string> {
  let s = cache.get(boardId);
  if (s === undefined) {
    s = readInitial(boardId);
    cache.set(boardId, s);
  }
  return s;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function toggle(boardId: string, laneKey: string): void {
  const next = new Set(snapshot(boardId));
  if (next.has(laneKey)) next.delete(laneKey);
  else next.add(laneKey);
  cache.set(boardId, next);
  try {
    window.localStorage.setItem(storageKey(boardId), JSON.stringify([...next]));
  } catch {
    // localStorage unavailable (private mode, quota) — keep the in-session value.
  }
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key && e.key.startsWith(COLLAPSED_LANES_STORAGE_PREFIX)) {
      // Another tab changed a board's lanes — drop the cache so it re-reads.
      cache.delete(e.key.slice(COLLAPSED_LANES_STORAGE_PREFIX.length));
      emit();
    }
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

export interface UseCollapsedLanesReturn {
  collapsed: ReadonlySet<string>;
  toggle: (laneKey: string) => void;
}

export function useCollapsedLanes(boardId: string): UseCollapsedLanesReturn {
  const collapsed = useSyncExternalStore(
    subscribe,
    () => snapshot(boardId),
    () => EMPTY,
  );
  const toggleLane = useCallback((laneKey: string) => toggle(boardId, laneKey), [boardId]);
  return { collapsed, toggle: toggleLane };
}
