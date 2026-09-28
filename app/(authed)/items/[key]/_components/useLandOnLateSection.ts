'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { LATE_FALLBACK_ATTR } from './decisionAnchor';

// LANDING ON A SECTION OF THE ITEM PAGE'S LATE TIER — one behaviour, two pointers.
//
// The header's decision-waiting marker (MOTIR-5878) and the To fix banner's
// *See its pull requests* link (MOTIR-6611) both point at a section that renders
// in the page's LATE tier (Development, Acceptance, Design result). Pressed before
// that section has streamed in, the pointer scrolls to the late stack's fallback,
// reports `pending`, and lands ONCE when the section mounts. If the stack settles
// with no such section (the reader cannot see it), it stops waiting and stays put.
// Landing scrolls the section to the top — smooth unless the reader prefers
// reduced motion — and moves focus to it, so a keyboard reader arrives there too.

function land(el: HTMLElement) {
  const reduced =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
  el.focus({ preventScroll: true });
}

/**
 * `find` answers the section to land on, or `null` while it has not mounted.
 * Returns the press handler and whether a press is waiting for the late stack.
 */
export function useLandOnLateSection(find: () => HTMLElement | null): {
  press: () => void;
  pending: boolean;
} {
  const [pending, setPending] = useState(false);
  const observer = useRef<MutationObserver | null>(null);

  const stopWaiting = useCallback(() => {
    observer.current?.disconnect();
    observer.current = null;
    setPending(false);
  }, []);

  useEffect(() => () => observer.current?.disconnect(), []);

  const press = useCallback(() => {
    const target = find();
    if (target) {
      land(target);
      return;
    }
    const fallback = document.querySelector<HTMLElement>(`[${LATE_FALLBACK_ATTR}]`);
    if (!fallback) return;
    fallback.scrollIntoView({ block: 'start' });
    setPending(true);
    observer.current?.disconnect();
    observer.current = new MutationObserver(() => {
      const mounted = find();
      if (mounted) {
        stopWaiting();
        land(mounted);
      } else if (!document.querySelector(`[${LATE_FALLBACK_ATTR}]`)) {
        stopWaiting();
      }
    });
    observer.current.observe(document.body, { childList: true, subtree: true });
  }, [find, stopWaiting]);

  return { press, pending };
}
