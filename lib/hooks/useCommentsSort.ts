'use client';

import { useSyncExternalStore } from 'react';

/**
 * The per-user comments sort preference (Story 5.1 · Subtask 5.1.5) — Jira's
 * "Reverse sort direction" persisted client-side, mirroring the
 * `useSidebarCollapsed` localStorage store pattern: a module-level cached
 * snapshot read through `useSyncExternalStore`, so SSR paints the stable
 * oldest-first default (the Jira default sort) and the stored choice applies
 * right after hydration without a setState-in-effect.
 *
 * Persisted under `prodect.issues.comments.sort` in the `prodect.*` namespace.
 */
export const COMMENTS_SORT_STORAGE_KEY = 'prodect.issues.comments.sort';

export type CommentsSortOrder = 'asc' | 'desc';

const listeners = new Set<() => void>();

/** `undefined` until the first lazy read; cached thereafter. */
let order: CommentsSortOrder | undefined;

function readInitial(): CommentsSortOrder {
  if (typeof window === 'undefined') return 'asc';
  try {
    return window.localStorage.getItem(COMMENTS_SORT_STORAGE_KEY) === 'desc' ? 'desc' : 'asc';
  } catch {
    return 'asc';
  }
}

function getSnapshot(): CommentsSortOrder {
  if (order === undefined) order = readInitial();
  return order;
}

/** Server render has no localStorage; oldest-first (stable). */
function getServerSnapshot(): CommentsSortOrder {
  return 'asc';
}

function emit(): void {
  for (const listener of listeners) listener();
}

function write(next: CommentsSortOrder): void {
  order = next;
  try {
    window.localStorage.setItem(COMMENTS_SORT_STORAGE_KEY, next);
  } catch {
    // localStorage unavailable (private mode, quota) — the choice won't
    // persist across reloads, but the in-session value still applies.
  }
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCommentsSort(): [CommentsSortOrder, (next: CommentsSortOrder) => void] {
  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return [value, write];
}

/** Test hook — reset the module cache so each test re-reads localStorage. */
export function resetCommentsSortForTests(): void {
  order = undefined;
}
