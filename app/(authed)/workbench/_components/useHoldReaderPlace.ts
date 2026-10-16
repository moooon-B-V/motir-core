'use client';

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

// THE READER'S PLACE ON A BURST (Story MOTIR-8542 · Subtask MOTIR-8731;
// design-notes § 39 rule 3).
//
// The `updatedAt desc` tabs put an arrival at the TOP, so a catch-up after a
// hidden tab inserts several rows above wherever the reader was. The browser's
// own scroll anchoring is meant to absorb that, and nothing on this path turns it
// off (`overflow-anchor`), but it is not universal and it does not anchor at
// every offset. So the list holds the place itself: before each paint that
// changed the row set, the row that was FIRST IN VIEW is put back at the
// on-screen offset it had. Where native anchoring already did that, the
// measured delta is zero and nothing moves twice.
//
// ⚠️ ONLY ONCE THE READER HAS SCROLLED. At the top of the page the list's own top
// IS the reader's place, and an arrival appearing there is § 26 Panel 1's
// single-arrival drawing — holding the old first row would push the arrival out
// of sight. Scrolled down, the reader is looking at a row, and that row stays.
//
// ⚠️ IT READS LAYOUT, NEVER ROWS. The appliers decide what the list holds; this
// only measures where one element was and where it is now.

/** Rows the place is measured against, in the list's DOM order. */
const ROW_SELECTOR = '[data-testid^="workbench-row-"], [data-testid^="workbench-group-"]';

interface Anchor {
  id: string;
  top: number;
}

function scrollerOf(el: HTMLElement): HTMLElement {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

function viewportTop(scroller: HTMLElement): number {
  return scroller === document.scrollingElement || scroller === document.documentElement
    ? 0
    : scroller.getBoundingClientRect().top;
}

/** The first row whose top is at or below the scroller's top edge, with that top. */
function firstInView(root: HTMLElement, scroller: HTMLElement): Anchor | null {
  const edge = viewportTop(scroller);
  for (const el of root.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    const { top } = el.getBoundingClientRect();
    if (top >= edge) return { id: el.dataset.testid ?? '', top };
  }
  return null;
}

/**
 * Keep the row the reader was looking at in place when the rows named by
 * `signature` change.
 */
export function useHoldReaderPlace(rootRef: RefObject<HTMLElement | null>, signature: string) {
  const anchor = useRef<Anchor | null>(null);

  const capture = (): void => {
    const root = rootRef.current;
    if (!root) return;
    const scroller = scrollerOf(root);
    anchor.current = scroller.scrollTop > 0 ? firstInView(root, scroller) : null;
  };

  useLayoutEffect(() => {
    const root = rootRef.current;
    const held = anchor.current;
    if (root && held) {
      const el = root.querySelector<HTMLElement>(`[data-testid="${CSS.escape(held.id)}"]`);
      if (el) {
        const delta = el.getBoundingClientRect().top - held.top;
        if (Math.abs(delta) >= 1) scrollerOf(root).scrollBy(0, delta);
      }
    }
    capture();
    // `capture` reads only refs; the signature is the one input that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  useEffect(() => {
    // The reader moving is what changes their place; re-measure on every scroll,
    // anywhere (capture phase: a nested scroller does not bubble its scroll).
    window.addEventListener('scroll', capture, { capture: true, passive: true });
    window.addEventListener('resize', capture, { passive: true });
    return () => {
      window.removeEventListener('scroll', capture, { capture: true });
      window.removeEventListener('resize', capture);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
