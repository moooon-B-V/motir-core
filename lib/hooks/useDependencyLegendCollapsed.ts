'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * useDependencyLegendCollapsed — the canvas dependency-legend collapse state
 * (MOTIR-3838), persisted per viewer.
 *
 * A legend is a thing you read once. This one is drawn ON TOP of the graph it
 * explains, in a corner of a surface whose whole value is the space it has to draw
 * in, and it returns on every level that carries a dependency edge. The control
 * that puts it away is only worth having if the choice STICKS — a panel that
 * forgets is worse than no control, because you dismiss it, change level, and it is
 * back.
 *
 * Recipe copied from `lib/hooks/useSidebarCollapsed.ts` (and shared with
 * `useCollapsedLanes` / `useAttachmentsView`), not re-invented: a module-level
 * external store read LAZILY on the first snapshot so there is no flash and no
 * set-state-in-effect, changes flowing through `useSyncExternalStore`, a stable
 * `getServerSnapshot` so server and first client render agree, `try`/`catch` around
 * every storage access so private mode or a quota error degrades to the default,
 * and a cross-tab `storage` listener.
 *
 * ⚠️ ONE preference for EVERY canvas that draws the legend, deliberately. The
 * legend is the canvas's own chrome and `ProjectRoadmapCanvas` has four consumers;
 * a per-surface key would ask the same reader to dismiss the same explanation on
 * the roadmap and again on a plan. "I know what a dashed arrow means" is a fact
 * about the reader, not about the route.
 *
 * Persisted under `motir.canvas.dependencies.collapsed`, in the `motir.*`
 * namespace. Default `false` (EXPANDED) — the shipped state, so nothing changes
 * for anyone who never touches the control.
 */
export const DEPENDENCY_LEGEND_COLLAPSED_STORAGE_KEY = 'motir.canvas.dependencies.collapsed';

const listeners = new Set<() => void>();

/** `undefined` until the first lazy read; cached thereafter. */
let collapsed: boolean | undefined;

function readInitial(): boolean {
  /* v8 ignore next -- UNREACHABLE by React's own contract: `readInitial` runs only
     from `getSnapshot`, which React calls on the CLIENT; the server path goes to
     `getServerSnapshot` below. The invariant is asserted by the
     "renders EXPANDED under renderToString, without touching localStorage" test in
     `tests/components/useDependencyLegendCollapsed.test.tsx`. The guard stays so the
     module is importable in a non-DOM context. */
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(DEPENDENCY_LEGEND_COLLAPSED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function getSnapshot(): boolean {
  // Lazy initializer — runs exactly once, the first time any consumer reads.
  if (collapsed === undefined) collapsed = readInitial();
  return collapsed;
}

/** Server render has no localStorage; default to expanded (stable), which is also
 *  the shipped rendering — so the first client render cannot mismatch it. */
function getServerSnapshot(): boolean {
  return false;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function write(next: boolean): void {
  collapsed = next;
  try {
    window.localStorage.setItem(DEPENDENCY_LEGEND_COLLAPSED_STORAGE_KEY, String(next));
  } catch {
    // localStorage unavailable (private mode, quota) — the choice will not persist
    // across reloads, but the in-session value still applies.
  }
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Cross-tab sync: collapsing the legend in one tab collapses it in the others.
  const onStorage = (e: StorageEvent) => {
    if (e.key === DEPENDENCY_LEGEND_COLLAPSED_STORAGE_KEY) {
      collapsed = e.newValue === 'true';
      emit();
    }
  };
  /* v8 ignore start -- the `typeof window` arms are UNREACHABLE for the same reason
     as the one in `readInitial`: `useSyncExternalStore` does not subscribe during a
     server render, so `subscribe` only ever runs on the client. Asserted by the
     "renders EXPANDED under renderToString, without touching localStorage" test in
     `tests/components/useDependencyLegendCollapsed.test.tsx`, which renders this hook
     off-DOM and observes no storage access at all. The guards are kept because this
     is a verbatim copy of `useSidebarCollapsed`'s recipe and the three hooks must not
     drift. */
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage);
  }
  /* v8 ignore stop */
  return () => {
    listeners.delete(listener);
    /* v8 ignore next 3 -- same guard, same invariant, same test. */
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorage);
    }
  };
}

export type UseDependencyLegendCollapsedReturn = readonly [
  collapsed: boolean,
  toggleCollapsed: () => void,
];

export function useDependencyLegendCollapsed(): UseDependencyLegendCollapsedReturn {
  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const toggleCollapsed = useCallback(() => write(!getSnapshot()), []);
  return [value, toggleCollapsed] as const;
}

/** Test hook — reset the module cache so each test re-reads localStorage. */
export function resetDependencyLegendCollapsedForTests(): void {
  collapsed = undefined;
}
