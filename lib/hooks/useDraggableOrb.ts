'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DRAG_THRESHOLD_PX,
  VELOCITY_WINDOW_MS,
  boundsFor,
  clampToBounds,
  stepOrb,
  throwVelocity,
  type OrbPoint,
  type OrbState,
  type PointerSample,
} from '@/lib/planning/orbPhysics';

// The floating orb's drag + throw behaviour (MOTIR-3214) — pointer capture, the
// animation frame, and the viewport it lives in. Every decision about WHERE the
// orb goes is in `lib/planning/orbPhysics.ts`; this file is the wiring.
//
// ⚠️ THE POSITION IS WRITTEN TO `translate`, NOT TO `transform`, AND THAT IS LORE.
// The orb's own utility classes carry `hover:scale-105` / `active:scale-95`, and
// under Tailwind v4 those compile to the standalone `scale` property. CSS composes
// the individual transform properties in a FIXED order — translate, rotate, scale,
// then transform — so a position written into `transform` sits to the RIGHT of the
// scale and gets multiplied by it: hovering an orb dragged 500px from its corner
// moved it 25px further away, out from under the pointer chasing it (MOTIR-3214).
// `translate` composes to the LEFT of `scale`, so the two are independent: the orb
// grows in place, wherever it has been put.
//
// ⚠️ POSITION IS DELIBERATELY NOT PERSISTED. A new tab gets the orb back in its
// default corner, which is what was asked for — and it is also the safer default:
// a control that follows you across sessions to wherever you last flung it can
// end up somewhere you did not mean and cannot easily find. It DOES survive
// client-side navigation, because the component is mounted by the authed layout
// and never unmounts; that is the difference between "a new tab" and "a new
// page", and it is the distinction the request draws.
//
// ⚠️ AND IT IS NOT A `useState` ROUND TRIP PER FRAME. During a drag or a throw the
// position is written straight to the element's `transform`, and React state is
// updated only when the gesture ENDS. A `setState` per animation frame would
// re-render the whole popover subtree 120 times a second for a purely visual
// change, which is how a smooth control becomes a janky one on a busy page.

export interface DraggableOrb {
  /**
   * A CALLBACK ref for the orb element.
   *
   * Deliberately a callback rather than a `RefObject`: returning an object with a
   * `ref` property makes `react-hooks/refs` read the render-time `orb.ref` as a
   * ref ACCESS, and it is right to — a hook whose contract is "reach into my
   * internals" is a hook that can be misused. A callback ref hands the element in
   * and keeps `current` where it belongs.
   */
  attach: (el: HTMLButtonElement | null) => void;
  /** Spread onto the orb element. */
  onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => void;
  onClickCapture: (e: React.MouseEvent<HTMLButtonElement>) => void;
  /** True while a DRAG is in flight — the caller shows a grabbing cursor.
   *
   *  It deliberately does NOT gate a CSS transition any more. It used to, and the
   *  bug was structural: `dragging` goes false on `pointerup`, which is BEFORE the
   *  throw starts, so the whole flight was animated by a 150ms `transition-transform`
   *  easing toward each frame's position. The orb reversed ~350px short of the wall
   *  it was supposed to bounce off (MOTIR-3214). A property the physics writes every
   *  frame must not be a transitioned property at all — see `PlanWithAIFab`. */
  dragging: boolean;
}

/** Read the viewport. Split out so a test can drive it without a real window. */
function viewportSize(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}

export function useDraggableOrb(options: { size?: number } = {}): DraggableOrb {
  const size = options.size ?? 56;
  const ref = useRef<HTMLButtonElement | null>(null);
  const [dragging, setDragging] = useState(false);

  // The live position, in viewport px (the orb's top-left). `null` until the orb
  // has been moved, which is what keeps the default CSS corner authoritative.
  const pos = useRef<OrbPoint | null>(null);
  // Where the orb's CSS corner puts it when nothing is translated — the origin
  // every offset is measured from. Cached, because `offsetLeft` FLUSHES LAYOUT,
  // and reading it from inside the animation frame (which it used to) makes the
  // browser lay the page out again on every one of the flight's ~120 frames.
  // It only changes when the viewport does, so it is re-read there instead.
  const home = useRef<OrbPoint | null>(null);
  const grab = useRef<{ dx: number; dy: number } | null>(null);
  const trail = useRef<PointerSample[]>([]);
  const travelled = useRef(0);
  const suppressClick = useRef(false);
  const raf = useRef<number | null>(null);

  /** The orb's untransformed corner, measured once and reused. */
  const measureHome = useCallback((): OrbPoint | null => {
    const el = ref.current;
    if (!el) return null;
    // NOT `getBoundingClientRect()`: that box is the RENDERED one, so a hovered
    // orb measures 1.4px up and left of where it actually sits (`scale-105` of
    // 56px), and seeding the position from it made every grab creep. `offsetLeft`
    // is the layout box, which is what "the corner the CSS put it in" means.
    home.current = { x: el.offsetLeft, y: el.offsetTop };
    return home.current;
  }, []);

  const paint = useCallback(
    (p: OrbPoint) => {
      const el = ref.current;
      if (!el) return;
      const origin = home.current ?? measureHome();
      if (!origin) return;
      // `left/top` on a fixed element would lay out every frame; `translate` is
      // composited. The element keeps its `inset` classes and is offset from them.
      // See the header: this is `translate`, never `transform`, so the hover and
      // press scales cannot multiply it.
      el.style.translate = `${p.x - origin.x}px ${p.y - origin.y}px`;
    },
    [measureHome],
  );

  const stopFrame = useCallback(() => {
    if (raf.current !== null) {
      cancelAnimationFrame(raf.current);
      raf.current = null;
    }
  }, []);

  /** Run the throw until it rests. Reduced motion skips it entirely — the orb is
   *  already where the finger left it, and a ball bouncing across the screen is
   *  exactly the kind of motion that setting exists to refuse. */
  const fling = useCallback(
    (start: OrbState) => {
      const reduced =
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduced) return;

      let state = start;
      let last = performance.now();
      const tick = (now: number): void => {
        const dt = (now - last) / 1000;
        last = now;
        const next = stepOrb(state, dt, boundsFor(viewportSize(), size));
        state = next.state;
        pos.current = { x: state.x, y: state.y };
        paint(pos.current);
        if (next.resting) {
          raf.current = null;
          return;
        }
        raf.current = requestAnimationFrame(tick);
      };
      raf.current = requestAnimationFrame(tick);
    },
    [paint, size],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      // Only the primary button — a right-click must still reach the context menu.
      if (e.button !== 0) return;
      const el = ref.current;
      if (!el) return;
      stopFrame();
      // A gesture that ended without producing a `click` (the pointer was released
      // off the button, so the browser fires none) would otherwise leave this armed
      // and eat the NEXT genuine press. A new press is a new gesture.
      suppressClick.current = false;

      // Where the orb is now: wherever we last put it, or — the first time — the
      // corner the CSS put it in. Deliberately not the rendered rect; see
      // `measureHome`.
      const origin = measureHome();
      if (!origin) return;
      const at = pos.current ?? origin;
      pos.current = at;
      grab.current = { dx: e.clientX - at.x, dy: e.clientY - at.y };
      // The trail is seeded by the first MOVE, not by this press. Two reasons:
      // the press carries no travel, so including it drags the average down by
      // however long the finger rested before moving; and it is a React synthetic
      // event while the moves are native ones, so its `timeStamp` is not
      // guaranteed to share their clock. One clock, one kind of sample.
      trail.current = [];
      travelled.current = 0;
      el.setPointerCapture?.(e.pointerId);
      setDragging(true);

      const move = (ev: PointerEvent): void => {
        if (!grab.current) return;
        const bounds = boundsFor(viewportSize(), size);
        const next = clampToBounds(
          { x: ev.clientX - grab.current.dx, y: ev.clientY - grab.current.dy },
          bounds,
        );
        travelled.current += Math.hypot(
          next.x - (pos.current?.x ?? next.x),
          next.y - (pos.current?.y ?? next.y),
        );
        pos.current = next;
        // Only PAINT once the gesture is a drag. Below the threshold a shaky tap
        // would otherwise nudge the orb a pixel and leave it displaced, which
        // reads as the button drifting when you press it.
        if (travelled.current > DRAG_THRESHOLD_PX) paint(next);

        const t = ev.timeStamp;
        trail.current.push({ x: next.x, y: next.y, t });
        // Keep only the tail — `throwVelocity` reads the last window, and an
        // unbounded trail on a long drag is a slow leak.
        while (trail.current.length > 2 && t - trail.current[0]!.t > VELOCITY_WINDOW_MS * 2) {
          trail.current.shift();
        }
      };

      const up = (ev: PointerEvent): void => {
        el.releasePointerCapture?.(ev.pointerId);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        grab.current = null;
        setDragging(false);

        const isDrag = travelled.current > DRAG_THRESHOLD_PX;
        // A press that never moved is a CLICK: leave it to open the callout, and
        // do not consume it.
        if (!isDrag) return;
        suppressClick.current = true;

        const { vx, vy } = throwVelocity(trail.current);
        const p = pos.current;
        if (p && (vx !== 0 || vy !== 0)) fling({ x: p.x, y: p.y, vx, vy });
      };

      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    },
    [fling, measureHome, paint, size, stopFrame],
  );

  /** Swallow the click that a drag produces, so releasing a throw does not also
   *  open the callout. Capture phase, because Radix's trigger listens on the
   *  bubble phase. */
  const onClickCapture = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  // A resize can strand the orb outside the viewport — narrow the window after
  // throwing it right, and it is gone. Re-clamp rather than reset, so the user
  // keeps the corner they chose.
  useEffect(() => {
    const onResize = (): void => {
      if (!pos.current) return;
      stopFrame();
      // The CSS corner moves with the viewport, so the cached origin every offset
      // is measured from is stale the moment the window is resized.
      measureHome();
      pos.current = clampToBounds(pos.current, boundsFor(viewportSize(), size));
      paint(pos.current);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [measureHome, paint, size, stopFrame]);

  useEffect(() => stopFrame, [stopFrame]);

  // The element this ref last saw. Radix's `asChild` trigger composes a NEW ref
  // callback on every render, so React detaches and reattaches this one each time
  // — `attach` is called with null and then with the same node again, constantly.
  // Only a genuinely different node needs anything doing.
  const attached = useRef<HTMLButtonElement | null>(null);

  const attach = useCallback(
    (el: HTMLButtonElement | null) => {
      ref.current = el;
      if (!el || el === attached.current) return;
      attached.current = el;
      // A fresh element is a fresh corner and carries none of the old one's inline
      // offset, so the cached origin is dropped — and if the orb had already been
      // put somewhere, the new node is painted there rather than snapping back to
      // the corner behind the user's back.
      home.current = null;
      if (pos.current) paint(pos.current);
    },
    [paint],
  );

  return { attach, onPointerDown, onClickCapture, dragging };
}
