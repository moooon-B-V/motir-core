'use client';

import { useEffect, useRef, useState } from 'react';
import { pageChart } from './tokens';

/** The page chart height for a viewport height: `clamp(280px, 44vh, 420px)`. */
export function pageChartHeight(viewportHeight: number): number {
  return Math.min(
    pageChart.maxHeight,
    Math.max(pageChart.minHeight, Math.round(viewportHeight * pageChart.viewportRatio)),
  );
}

/**
 * Measure a chart container (Story MOTIR-8919): its pixel width via a
 * `ResizeObserver`, and the page height from the viewport. Before the first
 * measurement — SSR and first paint — it answers `initialWidth` and the design's
 * default height, so the page does not shift vertically when the real numbers
 * arrive. SSR-safe: with no `ResizeObserver` it simply keeps the initial values.
 */
export function useChartWidth<T extends HTMLElement>(
  initialWidth: number,
): { ref: React.RefObject<T | null>; width: number; height: number } {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(initialWidth);
  const [height, setHeight] = useState<number>(pageChart.defaultHeight);

  useEffect(() => {
    const onViewport = () => setHeight(pageChartHeight(window.innerHeight));
    onViewport();
    window.addEventListener('resize', onViewport);

    const el = ref.current;
    let observer: ResizeObserver | undefined;
    if (el && typeof ResizeObserver !== 'undefined') {
      const read = (w: number) => {
        if (w > 0) setWidth(Math.round(w));
      };
      read(el.getBoundingClientRect().width);
      observer = new ResizeObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (entry) read(entry.contentRect.width);
      });
      observer.observe(el);
    }
    return () => {
      window.removeEventListener('resize', onViewport);
      observer?.disconnect();
    };
  }, []);

  return { ref, width, height };
}
