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
//
// That budget is what `moving` (MOTIR-3226) is written against, and it holds: the
// flag is set through `setMovingTo`, which compares against a ref and returns
// early when nothing changed — so a 120-move drag costs ONE re-render at the
// threshold crossing and one at rest, not one per frame. Anything added here
// later owes the same arithmetic.

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
  /**
   * True while the orb is MOVING — the drag AND the throw that follows it
   * (MOTIR-3226). It goes true on the frame the gesture first crosses
   * {@link DRAG_THRESHOLD_PX} (the frame the orb is first painted anywhere new)
   * and false only when `stepOrb` reports the flight at rest — or immediately on
   * `pointerup` when no flight starts at all (reduced motion, or a drag released
   * with no velocity).
   *
   * ⚠️ THIS IS A SECOND SIGNAL, NOT A WIDER `dragging` — and the two must stay
   * apart. `dragging` goes false in `up()` BEFORE `fling()` is called, so it is
   * false for every frame of the flight; that is exactly right for the grabbing
   * CURSOR (the finger is gone) and exactly wrong for anything that has to
   * survive the throw. MOTIR-3214 was that mistake made with a CSS transition;
   * MOTIR-3226 is the same shape one layer up, with the callout's `open` state.
   * Widening `dragging` to cover the flight would leave a grabbing cursor on an
   * orb nobody is holding, so the fix ADDS a signal rather than stretching one.
   */
  moving: boolean;
}

export interface DraggableOrbOptions {
  /** The orb's edge, in px — it decides the box the physics keeps it inside. */
  size?: number;
  /**
   * Fired ONCE per gesture, on the frame {@link DraggableOrb.moving} goes true.
   *
   * It exists because {@link DraggableOrb.moving} alone cannot be ACTED on: the
   * orb is a popover trigger, closing that popover is a `setState`, and this
   * repo lints `react-hooks/set-state-in-effect` AND `set-state-in-render` as
   * errors — so a consumer has no legal place to watch the boolean from. An
   * event is the shape React actually wants here anyway, and it fires inside the
   * same `pointermove` handler that paints the orb, so the panel is gone in the
   * very frame the orb first moves rather than one commit later.
   */
  onMoveStart?: () => void;
}

/** Read the viewport. Split out so a test can drive it without a real window. */
function viewportSize(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}

export function useDraggableOrb(options: DraggableOrbOptions = {}): DraggableOrb {
  const size = options.size ?? 56;
  const ref = useRef<HTMLButtonElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [moving, setMoving] = useState(false);

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
  // `moving`, readable from inside the native pointer listeners and the frame
  // loop. Those closures capture the state value from the render they were
  // created in, and the flight outlives that render by ~120 frames — so the
  // decision "is this transition a CHANGE?" is made against the ref, and the
  // state exists only to re-render the consumer.
  const movingRef = useRef(false);
  // The latest `onMoveStart`, so a consumer passing an inline closure does not
  // re-create `onPointerDown` and so the frame loop never calls a stale one.
  const onMoveStart = useRef(options.onMoveStart);

  /** Set the moving signal, and tell the consumer when it RISES. */
  const setMovingTo = useCallback((next: boolean): void => {
    if (movingRef.current === next) return;
    movingRef.current = next;
    setMoving(next);
    if (next) onMoveStart.current?.();
  }, []);

  // Keep the callback fresh without putting it in any dependency array: a
  // consumer that passes an inline arrow would otherwise re-create
  // `onPointerDown` on every render, and the frame loop closes over this ref
  // rather than over one render's value.
  useEffect(() => {
    onMoveStart.current = options.onMoveStart;
  }, [options.onMoveStart]);

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
    (start: OrbState): boolean => {
      const reduced =
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduced) return false;

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
          // The flight is what kept `moving` true past `pointerup`; `stepOrb`
          // saying "resting" is the only thing that ends it.
          setMovingTo(false);
          return;
        }
        raf.current = requestAnimationFrame(tick);
      };
      raf.current = requestAnimationFrame(tick);
      return true;
    },
    [paint, setMovingTo, size],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      // Only the primary button — a right-click must still reach the context menu.
      if (e.button !== 0) return;
      const el = ref.current;
      if (!el) return;
      stopFrame();
      // Catching a flying orb ENDS the flight, so it is no longer moving — and a
      // press that goes on to stay put is a click, which must still open the
      // callout. Lowering the signal here is also what makes `onMoveStart` fire
      // once per GESTURE rather than once ever.
      setMovingTo(false);
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
        //
        // The same threshold raises `moving`, in the same frame and for the same
        // reason: the orb is MOVING exactly when it is being painted somewhere
        // new. `setMovingTo` is a no-op after the first crossing (it compares
        // against a ref), so the flag costs ONE re-render per gesture, not one
        // per pointer move — see the file header on why a per-frame `setState`
        // is not acceptable here.
        if (travelled.current > DRAG_THRESHOLD_PX) {
          paint(next);
          setMovingTo(true);
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
        const flying = p && (vx !== 0 || vy !== 0) ? fling({ x: p.x, y: p.y, vx, vy }) : false;
        // ⚠️ `moving` is deliberately NOT lowered next to `setDragging(false)`
        // above — that is precisely the ordering bug this signal exists to avoid
        // (MOTIR-3214's transition, MOTIR-3226's popover). It stays true while a
        // flight carries the orb on, and falls here only when no flight starts:
        // reduced motion (`fling` refuses), or a drag released with no velocity.
        if (!flying) setMovingTo(false);
      };

      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    },
    [fling, measureHome, paint, setMovingTo, size, stopFrame],
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
      // `stopFrame` above killed the flight mid-air, so nothing will ever report
      // it resting — the signal has to be lowered by whoever cancelled it.
      setMovingTo(false);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [measureHome, paint, setMovingTo, size, stopFrame]);

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

  return { attach, onPointerDown, onClickCapture, dragging, moving };
}
