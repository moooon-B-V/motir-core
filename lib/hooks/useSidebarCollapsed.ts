'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * useSidebarCollapsed — shared, persisted desktop-sidebar collapse state.
 *
 * The shell paints the sidebar three different ways (AppLayout's grid column
 * width, the Sidebar's row rendering, the footer toggle's chevron direction).
 * They MUST agree, so the boolean lives in a single module-level external
 * store rather than per-component `useState` — every `useSidebarCollapsed`
 * caller subscribes to the same source and re-renders together on toggle.
 *
 * Recipe mirrors `lib/contexts/theme-context.tsx`:
 *   - the initial value is read *lazily* from localStorage (once, on first
 *     snapshot) so there's no flash and no set-state-in-effect;
 *   - changes flow through `useSyncExternalStore`, the React-19-blessed
 *     primitive for subscribing to an external system (here, the store +
 *     the cross-tab `storage` event), instead of `useEffect` + `setState`.
 *
 * Persisted under `prodect.shell.sidebar.collapsed` in the same `prodect.*`
 * namespace as the theme keys. Default `false` (expanded).
 */
export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'prodect.shell.sidebar.collapsed';

const listeners = new Set<() => void>();

/** `undefined` until the first lazy read; cached thereafter. */
let collapsed: boolean | undefined;

function readInitial(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function getSnapshot(): boolean {
  // Lazy initializer — runs exactly once, the first time any consumer reads.
  if (collapsed === undefined) collapsed = readInitial();
  return collapsed;
}

/** Server render has no localStorage; default to expanded (stable). */
function getServerSnapshot(): boolean {
  return false;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function write(next: boolean): void {
  collapsed = next;
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(next));
  } catch {
    // localStorage unavailable (private mode, quota) — accept that the
    // choice won't persist across reloads, but keep the in-session value.
  }
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Cross-tab sync: another tab toggling the rail updates this one.
  const onStorage = (e: StorageEvent) => {
    if (e.key === SIDEBAR_COLLAPSED_STORAGE_KEY) {
      collapsed = e.newValue === 'true';
      emit();
    }
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorage);
    }
  };
}

export type UseSidebarCollapsedReturn = readonly [
  collapsed: boolean,
  setCollapsed: (value: boolean) => void,
  toggleCollapsed: () => void,
];

export function useSidebarCollapsed(): UseSidebarCollapsedReturn {
  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setCollapsed = useCallback((next: boolean) => write(next), []);
  const toggleCollapsed = useCallback(() => write(!getSnapshot()), []);

  return [value, setCollapsed, toggleCollapsed] as const;
}
