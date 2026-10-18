'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * useReportHelpHidden — whether the reader has put the per-report help text away
 * (Story MOTIR-8919), persisted in the browser.
 *
 * Recipe copied from `lib/hooks/useDependencyLegendCollapsed.ts` (itself
 * `useSidebarCollapsed`'s), not re-invented: a module-level external store read
 * LAZILY on the first snapshot, changes flowing through `useSyncExternalStore`, a
 * stable `getServerSnapshot` so the server and first client render agree,
 * `try`/`catch` around every storage access so private mode or a quota error
 * degrades to the default, and a cross-tab `storage` listener.
 *
 * ⚠️ ONE preference for EVERY report, deliberately. "I know what a report means"
 * is a fact about the reader, not about the route: hide the help on Created vs
 * Resolved and it is hidden on Workload too, after a reload, and on the next
 * visit. Nothing is stored on the server.
 *
 * Persisted under `motir.reports.help.hidden` (`'true'` = hidden; anything else
 * reads as shown). Default `false` (SHOWN) — the first visit explains itself.
 */
export const REPORT_HELP_HIDDEN_STORAGE_KEY = 'motir.reports.help.hidden';

const listeners = new Set<() => void>();

/** `undefined` until the first lazy read; cached thereafter. */
let hidden: boolean | undefined;

function readInitial(): boolean {
  /* v8 ignore next -- UNREACHABLE: `readInitial` runs only from `getSnapshot`,
     which React calls on the CLIENT; the server path uses `getServerSnapshot`.
     Asserted by the renderToString test in
     `tests/components/useReportHelpHidden.test.tsx`. */
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(REPORT_HELP_HIDDEN_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function getSnapshot(): boolean {
  if (hidden === undefined) hidden = readInitial();
  return hidden;
}

/** The server render has no localStorage; SHOWN is stable and is the default. */
function getServerSnapshot(): boolean {
  return false;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function write(next: boolean): void {
  hidden = next;
  try {
    window.localStorage.setItem(REPORT_HELP_HIDDEN_STORAGE_KEY, String(next));
  } catch {
    // localStorage unavailable (private mode, quota) — the choice will not persist
    // across reloads, but the in-session value still applies.
  }
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Cross-tab sync: hiding the help in one tab hides it in the others.
  const onStorage = (e: StorageEvent) => {
    if (e.key === REPORT_HELP_HIDDEN_STORAGE_KEY) {
      hidden = e.newValue === 'true';
      emit();
    }
  };
  /* v8 ignore start -- the `typeof window` arms are UNREACHABLE: `useSyncExternalStore`
     does not subscribe during a server render. Kept because this is a verbatim copy
     of the sibling hooks' recipe and they must not drift. */
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage);
  }
  /* v8 ignore stop */
  return () => {
    listeners.delete(listener);
    /* v8 ignore next 3 -- same guard, same invariant. */
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorage);
    }
  };
}

export type UseReportHelpHiddenReturn = readonly [hidden: boolean, toggleHidden: () => void];

export function useReportHelpHidden(): UseReportHelpHiddenReturn {
  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const toggleHidden = useCallback(() => write(!getSnapshot()), []);
  return [value, toggleHidden] as const;
}

/** Test hook — reset the module cache so each test re-reads localStorage. */
export function resetReportHelpHiddenForTests(): void {
  hidden = undefined;
}
