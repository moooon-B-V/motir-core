'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { RAIL_WIDTH_STORAGE_KEY } from '@/lib/planning/railWidth';

/**
 * usePlanningRailWidth — the planning conversation pane's PERSISTED width.
 *
 * The recipe is `lib/hooks/useSidebarCollapsed.ts`'s, deliberately and almost
 * line for line, because it is the mould this repo already has four of
 * (`useSidebarCollapsed`, `useCommentsSort`, `useAttachmentsView`,
 * `useCollapsedLanes`):
 *
 *   - the value is read LAZILY from localStorage, once, on the first snapshot —
 *     so there is no flash and no set-state-in-effect;
 *   - changes flow through `useSyncExternalStore`, which is also what gives the
 *     cross-tab `storage` sync for free;
 *   - a write that throws (private mode, quota) is ACCEPTED: the width stops
 *     persisting and the session keeps working. It is a convenience, not state
 *     the product depends on.
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

const listeners = new Set<() => void>();

/** `undefined` until the first lazy read; `null` means "never dragged". */
let stored: number | null | undefined;

function parse(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  // A non-numeric or non-positive value is somebody else's key, a truncated
  // write, or a hand-edited one — treat it as "never dragged" rather than as a
  // width, so a corrupt entry degrades to the default instead of to zero.
  return Number.isFinite(n) && n > 0 ? n : null;
}

function readInitial(): number | null {
  if (typeof window === 'undefined') return null;
  try {
    return parse(window.localStorage.getItem(RAIL_WIDTH_STORAGE_KEY));
  } catch {
    return null;
  }
}

function getSnapshot(): number | null {
  if (stored === undefined) stored = readInitial();
  return stored;
}

/** Server render has no localStorage; "never dragged" is the stable answer. */
function getServerSnapshot(): number | null {
  return null;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function write(next: number | null): void {
  stored = next === null ? null : Math.round(next);
  try {
    if (stored === null) window.localStorage.removeItem(RAIL_WIDTH_STORAGE_KEY);
    else window.localStorage.setItem(RAIL_WIDTH_STORAGE_KEY, String(stored));
  } catch {
    // localStorage unavailable — keep the in-session value and accept that it
    // will not survive a reload.
  }
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === RAIL_WIDTH_STORAGE_KEY) {
      stored = parse(e.newValue);
      emit();
    }
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

export type UsePlanningRailWidthReturn = readonly [
  /** The stored width in CSS pixels, or `null` when the divider has never been dragged. */
  width: number | null,
  /** Persist a width, or `null` to forget it. Rounded to whole pixels. */
  setWidth: (value: number | null) => void,
];

export function usePlanningRailWidth(): UsePlanningRailWidthReturn {
  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const setWidth = useCallback((next: number | null) => write(next), []);
  return [value, setWidth] as const;
}

/** Test hook — drop the module cache so each test re-reads localStorage. */
export function __resetPlanningRailWidthForTests(): void {
  stored = undefined;
}
