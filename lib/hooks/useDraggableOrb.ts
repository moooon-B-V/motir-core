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

// The floating orb's drag + throw behaviour (MOTIR-3208) — pointer capture, the
// animation frame, and the viewport it lives in. Every decision about WHERE the
// orb goes is in `lib/planning/orbPhysics.ts`; this file is the wiring.
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
  /** True while a gesture is in flight — the caller suppresses its transition so
   *  the orb tracks the finger exactly rather than easing toward it. */
  dragging: boolean;
  /** True once the orb has been moved: the caller then stops applying its default
   *  corner classes and lets the transform place it. */
  moved: boolean;
}

/** Read the viewport. Split out so a test can drive it without a real window. */
function viewportSize(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}

export function useDraggableOrb(options: { size?: number } = {}): DraggableOrb {
  const size = options.size ?? 56;
  const ref = useRef<HTMLButtonElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [moved, setMoved] = useState(false);

  // The live position, in viewport px (the orb's top-left). `null` until the orb
  // has been moved, which is what keeps the default CSS corner authoritative.
  const pos = useRef<OrbPoint | null>(null);
  const grab = useRef<{ dx: number; dy: number } | null>(null);
  const trail = useRef<PointerSample[]>([]);
  const travelled = useRef(0);
  const suppressClick = useRef(false);
  const raf = useRef<number | null>(null);

  const paint = useCallback((p: OrbPoint) => {
    const el = ref.current;
    if (!el) return;
    // `left/top` on a fixed element would lay out every frame; a transform is
    // composited. The element keeps its `inset` classes and is offset from them.
    el.style.transform = `translate3d(${p.x - el.offsetLeft}px, ${p.y - el.offsetTop}px, 0)`;
  }, []);

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

      const rect = el.getBoundingClientRect();
      pos.current = { x: rect.left, y: rect.top };
      grab.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
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
        if (travelled.current > DRAG_THRESHOLD_PX) {
          setMoved(true);
          paint(next);
        }

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
    [fling, paint, size, stopFrame],
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
      pos.current = clampToBounds(pos.current, boundsFor(viewportSize(), size));
      paint(pos.current);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [paint, size, stopFrame]);

  useEffect(() => stopFrame, [stopFrame]);

  const attach = useCallback((el: HTMLButtonElement | null) => {
    ref.current = el;
  }, []);

  return { attach, onPointerDown, onClickCapture, dragging, moved };
}
