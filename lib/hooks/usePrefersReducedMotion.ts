'use client';

import { useSyncExternalStore } from 'react';

// `prefers-reduced-motion: reduce`, live. The other readers in this tree take a
// one-off `matchMedia` snapshot at the moment they animate; the typewriter
// (MOTIR-8595) renders a different tree under reduce, so it subscribes.

const QUERY = '(prefers-reduced-motion: reduce)';

function media(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(QUERY)
    : null;
}

function subscribe(onChange: () => void): () => void {
  const list = media();
  if (!list) return () => {};
  list.addEventListener?.('change', onChange);
  return () => list.removeEventListener?.('change', onChange);
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => media()?.matches ?? false,
    () => false,
  );
}
