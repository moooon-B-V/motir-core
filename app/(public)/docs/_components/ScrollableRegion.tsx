'use client';

import { useEffect, useState, type ReactNode } from 'react';

// A scroll container a KEYBOARD can reach (MOTIR-2494).
//
// ⚠️ WHY THIS EXISTS. The docs surface scrolls its wide content inside its own
// boxes rather than sideways-scrolling the page — a `curl` line is wider than
// any phone, and a three-column parameter table is wider than most (see the
// wide-content rule in `CodeBlock` and Panel 9 of `design/api-docs/`). Every one
// of those boxes was a scrollable region containing nothing focusable, so there
// was no way to scroll one from the keyboard: axe's `scrollable-region-focusable`
// (serious, WCAG 2.1 A) fired on 20+ nodes of `/docs/api`. A sighted mouse user
// drags the pane and never learns there was anything to learn; a keyboard-only
// reader sees the first few lines of every sample. This is the surface whose
// whole job is to be read, published with no session gate precisely so it can
// be.
//
// ── ONLY a pane that actually OVERFLOWS becomes a focus stop ────────────────
// Making all 20+ panes focusable unconditionally clears the axe rule in one
// line and is the wrong fix: it hands a keyboard reader twenty-odd stops, most
// of which scroll nothing, between them and the next link. Whether a box
// overflows is not knowable statically — it depends on the rendered width, the
// font, and the viewport — so it is MEASURED here, and re-measured whenever the
// box resizes. Below the measurement (no layout, no `ResizeObserver`) the
// element stays a plain, non-focusable container, which is the correct
// degradation: nothing scrolls there either.
//
// ── `role="group"`, deliberately NOT `role="region"` ────────────────────────
// A named `region` is a LANDMARK. Twenty-plus of them would flood landmark
// navigation on the one page a screen-reader user most wants to navigate by
// landmark — and several would share a name (`application/json` appears on most
// operations), which is its own defect. `group` + a name announces the stop as
// something ("application/json, group") without touching the landmark list.
//
// The name comes from `labelledBy` — the id of the caption or heading ALREADY
// visible above the box. Naming it from what the reader can see is what keeps
// the accessible name and the page in step; a hand-written `aria-label` would
// be a second string to translate and to keep true.

export function ScrollableRegion({
  as = 'div',
  className,
  labelledBy,
  remeasureOn,
  children,
}: {
  /** The scrolling element itself — `pre` for a code pane, `div` for a table. */
  as?: 'div' | 'pre';
  className?: string;
  /** id of the VISIBLE element that names this region (a caption, a heading). */
  labelledBy: string;
  /**
   * A value that changes when the CONTENT changes. `ResizeObserver` watches the
   * box, not what is in it, so swapping the content of an element that keeps its
   * size would otherwise leave a stale measurement behind.
   */
  remeasureOn?: string;
  children: ReactNode;
}) {
  // A callback ref rather than `useRef`: it gives the effect a dependency that
  // actually changes when the node attaches, and it keeps every `setState` out
  // of the effect BODY (`react-hooks/set-state-in-effect` is an error here).
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [scrollable, setScrollable] = useState(false);

  useEffect(() => {
    if (!element || typeof ResizeObserver === 'undefined') return;
    // The measurement runs in the observer's CALLBACK, including the first one:
    // observing an element delivers an initial notification, so there is no
    // separate synchronous measure to write here.
    const observer = new ResizeObserver(() => {
      setScrollable(
        element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight,
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, remeasureOn]);

  const props = {
    ref: setElement,
    className,
    ...(scrollable
      ? { tabIndex: 0, role: 'group', 'aria-labelledby': labelledBy }
      : // Not a focus stop, so it needs neither a role nor a name — an
        // `aria-label` on a role-less element is prohibited and ignored anyway.
        {}),
    children,
  };

  return as === 'pre' ? <pre {...props} /> : <div {...props} />;
}

/**
 * The focus ring for a scroll region.
 *
 * An INSET outline, not the usual `ring-2`: these boxes sit inside an
 * `overflow-hidden` wrapper (`CodeBlock`) which would clip a ring drawn outside
 * the border, leaving a focus stop with no visible indicator at all.
 */
export const SCROLLABLE_REGION_FOCUS =
  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--focus-ring-color)';
