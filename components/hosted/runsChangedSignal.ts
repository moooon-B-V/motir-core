'use client';

import { useEffect, useRef } from 'react';

// A HOSTED START MADE OUTSIDE THE RUN SECTION'S PROVIDER (Story MOTIR-1626 · MOTIR-6930).
//
// The item page's Run section keeps its run history in a CLIENT island, refetched on the
// `HostedRunProvider` tick (CLAUDE.md § Page state after a mutation, case 3). The To fix
// banner's *Fix on the hosted agent* sits at the top of the main column, outside that
// provider, so its start cannot bump the tick directly. It announces the start here
// instead, and the provider — which listens for its own card — bumps the tick. The
// banner's `router.refresh()` covers the server-rendered surfaces; this covers the island.

const EVENT = 'motir:hosted-runs-changed';

/**
 * A hosted run started (or ended) on `itemKey` from outside its Run section. Called only
 * from a press's answer (`ToFixHostedDoor`), so it always runs in the browser.
 */
export function announceRunsChanged(itemKey: string): void {
  window.dispatchEvent(new CustomEvent<{ itemKey: string }>(EVENT, { detail: { itemKey } }));
}

/** Call `onChange` whenever a start on `itemKey` is announced. */
export function useRunsChangedSignal(itemKey: string, onChange: () => void): void {
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  }, [onChange]);
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ itemKey?: string }>).detail;
      if (detail?.itemKey === itemKey) latest.current();
    };
    window.addEventListener(EVENT, listener);
    return () => window.removeEventListener(EVENT, listener);
  }, [itemKey]);
}
