'use client';

import { useSyncExternalStore } from 'react';

/**
 * The per-user attachments view preference (Story 5.2 · Subtask 5.2.5) — the
 * panel's strip/list toggle persisted client-side, mirroring the
 * `useCommentsSort` localStorage store pattern: a module-level cached
 * snapshot read through `useSyncExternalStore`, so SSR paints the stable
 * strip default (the mockup's primary view) and the stored choice applies
 * right after hydration without a setState-in-effect.
 *
 * Persisted under `motir.issues.attachments.view` in the `motir.*`
 * namespace.
 */
export const ATTACHMENTS_VIEW_STORAGE_KEY = 'motir.issues.attachments.view';

export type AttachmentsView = 'strip' | 'list';

const listeners = new Set<() => void>();

/** `undefined` until the first lazy read; cached thereafter. */
let view: AttachmentsView | undefined;

function readInitial(): AttachmentsView {
  if (typeof window === 'undefined') return 'strip';
  try {
    return window.localStorage.getItem(ATTACHMENTS_VIEW_STORAGE_KEY) === 'list' ? 'list' : 'strip';
  } catch {
    return 'strip';
  }
}

function getSnapshot(): AttachmentsView {
  if (view === undefined) view = readInitial();
  return view;
}

/** Server render has no localStorage; strip (stable). */
function getServerSnapshot(): AttachmentsView {
  return 'strip';
}

function emit(): void {
  for (const listener of listeners) listener();
}

function write(next: AttachmentsView): void {
  view = next;
  try {
    window.localStorage.setItem(ATTACHMENTS_VIEW_STORAGE_KEY, next);
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

export function useAttachmentsView(): [AttachmentsView, (next: AttachmentsView) => void] {
  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return [value, write];
}

/** Test hook — reset the module cache so each test re-reads localStorage. */
export function resetAttachmentsViewForTests(): void {
  view = undefined;
}
