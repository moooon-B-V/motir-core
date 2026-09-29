'use client';

import { useLayoutEffect } from 'react';
import { withVisitorAddress } from '@/lib/visitor/address';

// THE VISITOR TAB NAMES ITS PROJECT ON EVERY REQUEST (Bug MOTIR-6892;
// `lib/visitor/address.ts`). Mounted once by the Visitor tree's layout, it wraps
// THIS window's `fetch` so each same-origin request — every data door the shared
// bodies call, and the server actions Next posts through the same `fetch` (the
// tree's levels) — carries the public project's identifier as a header. A window
// is one tab, so the address is per TAB: a member page in another tab, clearing
// the `motir_visitor` cookie, no longer takes this tab's project away.
//
// A LAYOUT effect, not a passive one: every layout effect in the tree commits
// before any passive effect runs, so the shared bodies' mount-time fetches
// (`useEffect`, children first) already go out through the wrapper. Leaving the
// Visitor tree restores the original `fetch`, so a member page the tab moves on
// to sends no address.

export function VisitorAddressFetch({ identifier }: { identifier: string }) {
  useLayoutEffect(() => {
    const original = window.fetch;
    const wrapped = withVisitorAddress(original.bind(window), identifier, window.location.origin);
    window.fetch = wrapped;
    return () => {
      // Only undo our own wrapper — never a later one somebody else installed.
      if (window.fetch === wrapped) window.fetch = original;
    };
  }, [identifier]);
  return null;
}
