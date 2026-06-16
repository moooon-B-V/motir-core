'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * The dismissed state of the one-time "Build in public" project-shell nudge
 * (Story 6.17 · Subtask 6.17.3 · design Panel 10b), persisted per-project in
 * localStorage — mirroring the `useCommentsSort` store pattern (a module-level
 * cached snapshot read through `useSyncExternalStore`), which is the
 * lint-clean, SSR-safe way to read localStorage here (no setState-in-effect).
 *
 * SSR + the first hydration render paint the nudge HIDDEN (the stable server
 * snapshot), so a dismissed nudge never flashes; right after hydration the
 * stored value applies, revealing the nudge only when it hasn't been dismissed.
 * Keyed per project so dismissing one project's nudge doesn't hide another's.
 */
const STORAGE_PREFIX = 'motir.buildInPublic.nudgeDismissed.';
const storageKey = (projectKey: string) => `${STORAGE_PREFIX}${projectKey}`;

const listeners = new Set<() => void>();
/** Per-project cached snapshot — populated lazily on first read, kept stable so
 * `useSyncExternalStore` sees a referentially-stable value between emits. */
const cache = new Map<string, boolean>();

function read(projectKey: string): boolean {
  if (typeof window === 'undefined') return true; // server: hidden (stable)
  try {
    return window.localStorage.getItem(storageKey(projectKey)) === '1';
  } catch {
    return false;
  }
}

function getSnapshot(projectKey: string): boolean {
  if (!cache.has(projectKey)) cache.set(projectKey, read(projectKey));
  return cache.get(projectKey)!;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Persist the dismissal for one project + notify subscribers. */
export function dismissBuildInPublicNudge(projectKey: string): void {
  cache.set(projectKey, true);
  try {
    window.localStorage.setItem(storageKey(projectKey), '1');
  } catch {
    // localStorage unavailable (private mode / quota) — the dismissal won't
    // persist across reloads, but the in-session hide still applies via cache.
  }
  emit();
}

/** `[dismissed, dismiss]` for one project's nudge. */
export function useBuildInPublicNudge(projectKey: string): [boolean, () => void] {
  const dismissed = useSyncExternalStore(
    subscribe,
    () => getSnapshot(projectKey),
    () => true, // server snapshot: hidden, stable
  );
  const dismiss = useCallback(() => dismissBuildInPublicNudge(projectKey), [projectKey]);
  return [dismissed, dismiss];
}

/** Test hook — clear the module cache so each test re-reads localStorage. */
export function resetBuildInPublicNudgeForTests(): void {
  cache.clear();
}
