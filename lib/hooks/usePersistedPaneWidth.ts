'use client';

import { useCallback, useMemo, useSyncExternalStore } from 'react';

/**
 * usePersistedPaneWidth — a split's second pane's PERSISTED width, keyed by the
 * host's own storage key (MOTIR-9068; it was `usePlanningRailWidth` while the
 * planning workspace was the only host).
 *
 * The recipe is `lib/hooks/useSidebarCollapsed.ts`'s, deliberately and almost
 * line for line, because it is the mould this repo already has four of
 * (`useSidebarCollapsed`, `useCommentsSort`, `useAttachmentsView`,
 * `useCollapsedLanes`):
 *
 *   - the value is read LAZILY from localStorage, once per key, on the first
 *     snapshot — so there is no flash and no set-state-in-effect;
 *   - changes flow through `useSyncExternalStore`, which is also what gives the
 *     cross-tab `storage` sync for free;
 *   - a write that throws (private mode, quota) is ACCEPTED: the width stops
 *     persisting and the session keeps working. It is a convenience, not state
 *     the product depends on.
 *
 * ⚠️ THE STORE IS KEYED, NOT SINGLE-VALUED. The snapshot cache and the listener
 * set are per storage key, and the `storage` handler matches on its own key only.
 * One module-level `stored` would hand a second host the first host's width on its
 * first read, and a drag in either would overwrite the other's entry.
 *
 * ⚠️ `null` IS THE MEANINGFUL DEFAULT, not `0` and not a number. It means *this
 * person has never dragged the divider*, which is different from *they dragged it
 * to the default*: the first follows the container as the window resizes (a third
 * of whatever it now is), and the second is a pixel width they chose. Collapsing
 * the two would silently pin every new viewer to a width computed once.
 *
 * ⚠️ AND THE STORED NUMBER IS NOT TRUSTED. It is written from one container and
 * read in another — a width stored on a 2560px monitor, reopened on a laptop — so
 * every consumer clamps it through `clampRailWidth` against the CURRENT container.
 * This hook deliberately does not clamp: it has no container to clamp against, and
 * a hook that guessed one would be the second place the bounds live.
 */

interface PaneWidthEntry {
  listeners: Set<() => void>;
  /** `undefined` until the first lazy read; `null` means "never dragged". */
  stored: number | null | undefined;
}

const entries = new Map<string, PaneWidthEntry>();

function entryFor(key: string): PaneWidthEntry {
  let entry = entries.get(key);
  if (!entry) {
    entry = { listeners: new Set(), stored: undefined };
    entries.set(key, entry);
  }
  return entry;
}

function parse(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  // A non-numeric or non-positive value is somebody else's key, a truncated
  // write, or a hand-edited one — treat it as "never dragged" rather than as a
  // width, so a corrupt entry degrades to the default instead of to zero.
  return Number.isFinite(n) && n > 0 ? n : null;
}

function readInitial(key: string): number | null {
  if (typeof window === 'undefined') return null;
  try {
    return parse(window.localStorage.getItem(key));
  } catch {
    return null;
  }
}

function getSnapshot(key: string): number | null {
  const entry = entryFor(key);
  if (entry.stored === undefined) entry.stored = readInitial(key);
  return entry.stored;
}

/** Server render has no localStorage; "never dragged" is the stable answer. */
function getServerSnapshot(): number | null {
  return null;
}

function emit(entry: PaneWidthEntry): void {
  for (const listener of entry.listeners) listener();
}

function write(key: string, next: number | null): void {
  const entry = entryFor(key);
  entry.stored = next === null ? null : Math.round(next);
  try {
    if (entry.stored === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, String(entry.stored));
  } catch {
    // localStorage unavailable — keep the in-session value and accept that it
    // will not survive a reload.
  }
  emit(entry);
}

function subscribe(key: string, listener: () => void): () => void {
  const entry = entryFor(key);
  entry.listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    // This key only — another host's entry changing is none of this listener's business.
    if (e.key === key) {
      entry.stored = parse(e.newValue);
      emit(entry);
    }
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    entry.listeners.delete(listener);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

export type UsePersistedPaneWidthReturn = readonly [
  /** The stored width in CSS pixels, or `null` when the divider has never been dragged. */
  width: number | null,
  /** Persist a width, or `null` to forget it. Rounded to whole pixels. */
  setWidth: (value: number | null) => void,
];

export function usePersistedPaneWidth(storageKey: string): UsePersistedPaneWidthReturn {
  const subscribeToKey = useMemo(
    () => (listener: () => void) => subscribe(storageKey, listener),
    [storageKey],
  );
  const getKeySnapshot = useCallback(() => getSnapshot(storageKey), [storageKey]);
  const value = useSyncExternalStore(subscribeToKey, getKeySnapshot, getServerSnapshot);
  const setWidth = useCallback((next: number | null) => write(storageKey, next), [storageKey]);
  return [value, setWidth] as const;
}

/** Test hook — drop every key's cache so each test re-reads localStorage. */
export function __resetPersistedPaneWidthsForTests(): void {
  for (const entry of entries.values()) entry.stored = undefined;
}
