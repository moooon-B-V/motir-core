'use client';

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

// useRowWindow — a hand-rolled list-windowing primitive (Subtask 3.2.5).
//
// It is the GENERALIZATION of the fixed-row windowing Story 2.5.15 built inside
// `components/ui/TreeTable.tsx`: same technique — only the rows in (or near) the
// scroll viewport mount, off-view rows are removed, a spacer keeps the FULL
// scroll height so the scrollbar stays honest, and it DEGRADES TO RENDER-ALL when
// no viewport is measurable (SSR / happy-dom tests) so markup is identical with
// or without a live scroll container. It adds NO dependency (the finding-#57 rule:
// "no second virtualization library").
//
// Why a sibling and not a literal reuse of TreeTable's code (a justified deviation
// per the decision-authority ladder, written here):
//   1. TreeTable rows are a FIXED 40px (its windowing is measurement-free, which
//      is what lets its strict-axe component tests be deterministic under
//      happy-dom — happy-dom does no layout, so `getBoundingClientRect` is 0).
//      BOARD CARDS are VARIABLE height (the title clamps to 1–2 lines) and their
//      padding is `--spacing-card-padding`, which the display-style swap layer
//      flips — so a single fixed ROW_PX would be wrong across cards AND across
//      display styles. This hook therefore MEASURES each row.
//   2. The mirror product (Jira / Linear) virtualizes variable-height board cards
//      with measured offsets — rung-1 of the decision ladder.
// TreeTable keeps its measurement-free fixed-row path untouched (its a11y tests
// depend on it); this hook is the measured form for variable-height lists. Both
// are hand-rolled, both degrade to render-all, neither pulls in a library.
//
// Measurement: the consumer attaches `measureElement(index)` to each rendered
// row. The hook reads the row's `offsetHeight` and caches it by index; unmeasured
// rows fall back to `estimateRowHeight`. Under happy-dom `offsetHeight` is 0, so
// nothing is measured, the viewport is unmeasurable, and the hook renders all.

export interface RowWindowOptions {
  /** Total number of rows in the (already loaded) list. */
  count: number;
  /** Fallback height (px) for a not-yet-measured row — keep it close to reality. */
  estimateRowHeight: number;
  /** Vertical gap (px) between consecutive rows; folded into each row's slot. */
  gap?: number;
  /** Extra px mounted beyond each viewport edge so fast scroll never flashes a gap. */
  overscanPx?: number;
  /**
   * The scroll viewport the list windows against. Defaults to the nearest
   * scrollable ANCESTOR of the container; supply a resolver to point at a
   * specific element (the board column body) or return null to disable windowing.
   */
  getScrollElement?: () => HTMLElement | null;
}

export interface RowWindowResult {
  /** Attach to the rows' positioned container (the spacer). */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** The slice `[start, end)` of rows currently mounted (whole list when not windowing). */
  range: { start: number; end: number };
  /** Total scroll height (px) of all rows incl. gaps — the spacer height when windowing. */
  totalSize: number;
  /** The absolute `top` (px) of a row by index — only meaningful when `windowing`. */
  getOffset: (index: number) => number;
  /** Ref callback factory: attach `measureElement(index)` to each rendered row. */
  measureElement: (index: number) => (el: HTMLElement | null) => void;
  /** True when the list is windowed; false when rendering every row (the degrade case). */
  windowing: boolean;
}

/** Walk up from `el` to the nearest ancestor that scrolls vertically. */
function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node && node !== document.body && node !== document.documentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return node;
    node = node.parentElement;
  }
  return null;
}

export function useRowWindow({
  count,
  estimateRowHeight,
  gap = 0,
  overscanPx = 300,
  getScrollElement,
}: RowWindowOptions): RowWindowResult {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollElRef = useRef<HTMLElement | null>(null);
  // Measured heights by row index (state, since they drive layout); unmeasured
  // rows fall back to the estimate. A new measurement re-derives the offsets.
  const [measured, setMeasured] = useState<Map<number, number>>(() => new Map());

  // Cumulative offsets: offset[i] = top of row i (incl. preceding gaps); the last
  // entry is the total scroll size. Recomputed when the count, the measured
  // heights, or the estimate/gap change.
  const offsets = useMemo(() => {
    const out = new Array<number>(count + 1);
    let acc = 0;
    out[0] = 0;
    for (let i = 0; i < count; i++) {
      acc += (measured.get(i) ?? estimateRowHeight) + gap;
      out[i + 1] = acc;
    }
    return out;
  }, [count, estimateRowHeight, gap, measured]);

  const totalSize = offsets[count] ?? 0;
  const getOffset = useCallback((index: number) => offsets[index] ?? 0, [offsets]);

  // `null` = degrade to render-all (no measurable viewport). Otherwise [start,end).
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);

  const recompute = useCallback(() => {
    const scrollEl = scrollElRef.current;
    const container = containerRef.current;
    const viewportH = scrollEl?.clientHeight ?? 0;
    if (!scrollEl || !container || viewportH <= 0 || count === 0) {
      setRange(null); // no measurable viewport → render all
      return;
    }
    // Content fits the viewport → render in natural flow (no windowing, no
    // absolute positioning, no first-paint reflow). Only a column taller than its
    // viewport virtualizes.
    if ((offsets[count] ?? 0) <= viewportH) {
      setRange(null);
      return;
    }
    // Distance from the container's top to the viewport's top (scroll-invariant).
    const bodyOffset =
      container.getBoundingClientRect().top -
      scrollEl.getBoundingClientRect().top +
      scrollEl.scrollTop;
    const top = scrollEl.scrollTop - bodyOffset;
    const lo = top - overscanPx;
    const hi = top + viewportH + overscanPx;
    // Linear scan over the (bounded) loaded rows — first row whose bottom clears
    // `lo`, last row whose top is before `hi`.
    let start = count;
    for (let i = 0; i < count; i++) {
      if (offsets[i + 1]! > lo) {
        start = i;
        break;
      }
    }
    let end = start;
    for (let i = start; i < count; i++) {
      if (offsets[i]! >= hi) break;
      end = i + 1;
    }
    setRange((prev) => (prev && prev.start === start && prev.end === end ? prev : { start, end }));
  }, [count, offsets, overscanPx]);

  // Resolve + observe the scroll viewport once mounted; re-window on scroll/resize.
  useLayoutEffect(() => {
    const scrollEl = getScrollElement ? getScrollElement() : findScrollParent(containerRef.current);
    scrollElRef.current = scrollEl;
    if (!scrollEl) {
      setRange(null);
      return;
    }
    recompute();
    const onScroll = () => recompute();
    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    let resizeObserver: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => recompute());
      resizeObserver.observe(scrollEl);
    }
    return () => {
      scrollEl.removeEventListener('scroll', onScroll);
      resizeObserver?.disconnect();
    };
  }, [getScrollElement, recompute]);

  // Recompute when the row count or total height changes (a page appended, or a
  // measurement landed).
  useLayoutEffect(() => {
    recompute();
  }, [count, totalSize, recompute]);

  const measureElement = useCallback(
    (index: number) => (el: HTMLElement | null) => {
      if (!el) return;
      const h = el.offsetHeight;
      if (h <= 0) return;
      // Re-derive offsets + re-window only when this row's height actually changed.
      setMeasured((prev) => {
        if (prev.get(index) === h) return prev;
        const next = new Map(prev);
        next.set(index, h);
        return next;
      });
    },
    [],
  );

  // A non-null `range` means recompute found a measurable viewport the content
  // overflows — i.e. we're windowing. Otherwise render every row (the degrade /
  // short-column case). The viewport-fit decision lives in `recompute` so nothing
  // reads a ref during render.
  const windowing = range !== null;

  return {
    containerRef,
    range: range ?? { start: 0, end: count },
    totalSize,
    getOffset,
    measureElement,
    windowing,
  };
}
