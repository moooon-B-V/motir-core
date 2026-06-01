'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * useSidebarDrawer — shared open/closed state for the mobile off-canvas
 * navigation drawer (the `<md` counterpart to the persistent desktop rail).
 *
 * Like `useSidebarCollapsed`, the state is shared via a module-level external
 * store so the hamburger trigger (which lives in the top nav) and the
 * `SidebarDrawer` (which can be mounted anywhere) agree without threading a
 * provider through the tree. Unlike the collapse state, drawer-open is
 * ephemeral — it is NOT persisted to localStorage (a refresh always lands
 * with the drawer closed).
 */
const listeners = new Set<() => void>();
let open = false;

function getSnapshot(): boolean {
  return open;
}

/** Server snapshot — the drawer is always closed on first paint. */
function getServerSnapshot(): boolean {
  return false;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function write(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const listener of listeners) listener();
}

export type UseSidebarDrawerReturn = readonly [open: boolean, setOpen: (value: boolean) => void];

export function useSidebarDrawer(): UseSidebarDrawerReturn {
  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const setOpen = useCallback((next: boolean) => write(next), []);
  return [value, setOpen] as const;
}
