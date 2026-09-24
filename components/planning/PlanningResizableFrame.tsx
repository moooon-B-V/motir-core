'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { useTranslations } from 'next-intl';
import { PlanningSplitDivider } from '@/components/planning/PlanningSplitDivider';
import { usePlanningRailWidth } from '@/lib/hooks/usePlanningRailWidth';
import {
  clampRailWidth,
  defaultRailWidth,
  isSplittable,
  railBounds,
  RAIL_KEYBOARD_COARSE_STEP_PX,
  RAIL_KEYBOARD_STEP_PX,
  RAIL_RESET_DURATION_MS,
} from '@/lib/planning/railWidth';

/**
 * The RESIZABLE two-pane frame (MOTIR-6250) — the planning workspace's split,
 * built to MOTIR-6249's approved design result.
 *
 * ── WHY THE DEFAULT NEEDS NO JAVASCRIPT ─────────────────────────────────────
 * The whole default is one CSS expression. `--rail-w` is declared as
 * `clamp(352px, 33.333%, 50%)` and the grid track reads it, and a percentage in
 * `grid-template-columns` resolves against the grid container's inline size — so
 * the FIRST PAINT is already correct, at every viewport, on the server, before a
 * single measurement or effect has run. JavaScript takes over only once a width
 * has actually been CHOSEN (dragged this session, or restored from a previous
 * one), at which point `--rail-w` becomes a pixel value.
 *
 * That is why there is no flash, no skeleton width and no set-state-in-effect
 * here, and it is also why `usePlanningRailWidth` returns `null` rather than a
 * number for "never dragged": `null` keeps the CSS expression, which keeps
 * FOLLOWING the container as the window resizes. A number would pin the pane to a
 * width computed once.
 *
 * ── WHAT A RESIZE MUST NOT DO ───────────────────────────────────────────────
 * It changes two panes' WIDTH and nothing else. Both panes are passed in as
 * `ReactNode` and are rendered in the same position in the same tree on every
 * width, so nothing about a resize re-mounts them: no key changes, no conditional
 * wrapper appears or disappears, no pane is swapped for a placeholder. That is
 * what keeps the canvas's scroll and its List | Canvas selection, and the
 * conversation's transcript scroll and its composer draft — a prop-seeded client
 * island is not reached by a re-render of its parent, so the ONLY way to lose its
 * state is to re-mount it, and this component structurally cannot.
 *
 * The one exception is the `md` boundary, where the frame genuinely changes shape
 * (two columns ↔ one) — the same boundary the fixed frame already shipped.
 */
export interface PlanningResizableFrameProps {
  canvas: ReactNode;
  chat: ReactNode;
  /**
   * Whether a plan PROPOSAL is present in the workspace's state. The reset fires
   * on the transition into `true` — the moment a proposal arrives — and not on a
   * route change, so it covers a plan being written as well as one that lands at
   * once.
   */
  proposalPresent?: boolean;
  /** Sizing for the frame, exactly as the fixed frame's `className` is. */
  className?: string;
}

export function PlanningResizableFrame({
  canvas,
  chat,
  proposalPresent = false,
  className,
}: PlanningResizableFrameProps) {
  const t = useTranslations('planningWorkspace');
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [stored, setStored] = usePlanningRailWidth();

  /**
   * The measured container width. `null` until the first observation — which is
   * exactly the window in which the CSS default is doing the work, so nothing
   * needs it. It is read for the CLAMP and for the divider's `aria-value*`, both
   * of which are meaningless without a container to be a fraction of.
   */
  const [containerPx, setContainerPx] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  /** The width being dragged, in px — `null` when no drag is in flight. */
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const [animating, setAnimating] = useState(false);

  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    // `ResizeObserver` rather than a window listener: the split container is not
    // the viewport on every host, and a container can change width without the
    // window doing so (a sidebar collapsing beside it).
    if (typeof ResizeObserver === 'undefined') {
      setContainerPx(el.clientWidth || null);
      return;
    }
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? el.clientWidth;
      if (w > 0) setContainerPx(w);
    });
    ro.observe(el);
    setContainerPx(el.clientWidth || null);
    return () => ro.disconnect();
  }, []);

  const splittable = containerPx === null || isSplittable(containerPx);

  /**
   * THE WIDTH THE FRAME IS PAINTING, or `null` to leave it to the CSS default.
   * A drag in flight wins; then a stored width, clamped into the CURRENT
   * container — a width stored on a large monitor must not open past the maximum
   * on a laptop.
   */
  const effectiveWidth =
    dragWidth ??
    (stored !== null && containerPx !== null ? clampRailWidth(stored, containerPx) : null);

  const bounds = containerPx !== null ? railBounds(containerPx) : null;
  const valueNow = effectiveWidth ?? (containerPx !== null ? defaultRailWidth(containerPx) : 0);

  /** Commit a width through the ONE clamp, and persist it. */
  const commit = useCallback(
    (next: number) => {
      if (containerPx === null) return;
      setStored(clampRailWidth(next, containerPx));
    },
    [containerPx, setStored],
  );

  // ── THE RESET ON PROPOSE ───────────────────────────────────────────────────
  //
  // ⚠️ ADJUSTED DURING RENDER, NOT IN AN EFFECT, and that is the shape React
  // documents for *"a prop changed, so derive new state"* rather than a style
  // preference. An effect that called `setDragWidth` synchronously in its body is
  // a cascading render — React commits the pre-reset width, paints it, then
  // re-renders — and `react-hooks/set-state-in-effect` rejects it. Comparing the
  // previous prop in render lets React re-render BEFORE committing anything, so
  // the wide frame is never painted on the way back to the default.
  //
  // It fires ONCE, on the transition INTO "a plan is proposed" — keyed on the
  // transition and not on the value, or somebody who drags wider to read a long
  // card is fought by the layout on every later re-render of the rail.
  const [wasProposed, setWasProposed] = useState(proposalPresent);
  if (proposalPresent !== wasProposed) {
    setWasProposed(proposalPresent);
    if (proposalPresent && containerPx !== null) {
      const target = defaultRailWidth(containerPx);
      const current = effectiveWidth ?? target;
      // A NO-OP at or below the default: there is nothing to give back, and
      // animating a frame that is already right is a flicker with no content.
      //
      // ⚠️ IT DOES NOT CLEAR THE STORED WIDTH — `setDragWidth`, never
      // `setStored`. The reset is a one-shot return for reading THIS plan; the
      // width the person chose is still theirs and comes back next time.
      if (current > target) {
        setDragWidth(target);
        // `matchMedia` is a read, so it is safe here; `window` exists because this
        // branch is only reachable from a client-side prop transition.
        const reduced =
          typeof window !== 'undefined' &&
          typeof window.matchMedia === 'function' &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (!reduced) setAnimating(true);
      }
    }
  }

  // The transition class is worn for exactly one duration. The `setState` is in the
  // TIMER CALLBACK rather than this effect's body, which is the arrangement
  // `react-hooks/set-state-in-effect` asks for — the body only talks to the
  // platform API.
  useEffect(() => {
    if (!animating) return;
    const timer = window.setTimeout(() => setAnimating(false), RAIL_RESET_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [animating]);

  // ── THE DRAG ───────────────────────────────────────────────────────────────
  /**
   * ⚠️ TWO refs, and the split matters. `scheduledRef` is set BEFORE
   * `requestAnimationFrame` is called, never from its return value.
   *
   * `rafIdRef.current = requestAnimationFrame(cb)` assigns AFTER `cb` has run
   * whenever `cb` runs synchronously, so the callback's own `= null` is
   * immediately overwritten by the id and the "already scheduled" guard latches
   * ON for ever — every later `pointermove` is then dropped and the divider
   * freezes at wherever the first event put it. A real browser's rAF is always
   * async, so it hides the defect completely; a polyfill, a fake timer or a test
   * harness does not.
   */
  const scheduledRef = useRef(false);
  const rafIdRef = useRef<number | null>(null);
  const pendingRef = useRef<number | null>(null);

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (containerPx === null) return;
      // Only the primary button drags; a right-click must not start one.
      if (event.button !== 0) return;
      event.preventDefault();
      const frame = frameRef.current;
      if (!frame) return;

      // CAPTURE the pointer, so the drag survives leaving the 11px strip and the
      // cursor stays `col-resize` across the whole window.
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // happy-dom and very old browsers omit it; the move listener below still
        // works, it is only the out-of-strip travel that degrades.
      }
      setDragging(true);
      setAnimating(false);
      const rect = frame.getBoundingClientRect();
      const right = rect.right || containerPx;

      const apply = (clientX: number) => {
        // The conversation is the RIGHT pane, so its width is the distance from
        // the pointer to the frame's right edge.
        pendingRef.current = clampRailWidth(right - clientX, containerPx);
        if (scheduledRef.current) return;
        // rAF-COALESCED: a pointermove can fire many times per frame, and the
        // panes only need one layout per frame.
        scheduledRef.current = true;
        rafIdRef.current = window.requestAnimationFrame(() => {
          scheduledRef.current = false;
          rafIdRef.current = null;
          if (pendingRef.current !== null) setDragWidth(pendingRef.current);
        });
      };

      const onMove = (e: globalThis.PointerEvent) => apply(e.clientX);
      const onUp = (e: globalThis.PointerEvent) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        if (rafIdRef.current !== null) window.cancelAnimationFrame(rafIdRef.current);
        scheduledRef.current = false;
        rafIdRef.current = null;
        setDragging(false);
        // Releasing outside the bounds commits the BOUND, not the pointer — the
        // clamp is the same one every other path goes through.
        const finalWidth = clampRailWidth(right - e.clientX, containerPx);
        setDragWidth(finalWidth);
        setStored(finalWidth);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      apply(event.clientX);
    },
    [containerPx, setStored],
  );

  // ── THE KEYBOARD PATH ──────────────────────────────────────────────────────
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (containerPx === null) return;
      const current = effectiveWidth ?? defaultRailWidth(containerPx);
      const { min, max } = railBounds(containerPx);
      const step = event.shiftKey ? RAIL_KEYBOARD_COARSE_STEP_PX : RAIL_KEYBOARD_STEP_PX;

      let next: number | null = null;
      switch (event.key) {
        // ⚠️ THE ARROWS MOVE THE DIVIDER, NOT A PANE. `←` moves the divider LEFT,
        // which happens to WIDEN the conversation, because the conversation is the
        // right pane. Naming the divider's direction is what keeps it guessable.
        case 'ArrowLeft':
          next = current + step;
          break;
        case 'ArrowRight':
          next = current - step;
          break;
        case 'Home':
          next = min;
          break;
        case 'End':
          next = max;
          break;
        case 'Enter':
          next = defaultRailWidth(containerPx);
          break;
        default:
          return;
      }
      event.preventDefault();
      setAnimating(false);
      const clamped = clampRailWidth(next, containerPx);
      setDragWidth(clamped);
      commit(clamped);
    },
    [commit, containerPx, effectiveWidth],
  );

  useEffect(
    () => () => {
      if (rafIdRef.current !== null) window.cancelAnimationFrame(rafIdRef.current);
    },
    [],
  );

  return (
    <div
      ref={frameRef}
      data-testid="planning-resizable-frame"
      data-dragging={dragging ? 'true' : undefined}
      // `--rail-w` is the ONE knob: the CSS default when no width has been
      // chosen, a pixel value once one has. The grid track reads it and nothing
      // else does.
      style={
        {
          '--rail-w':
            effectiveWidth !== null
              ? `${Math.round(effectiveWidth)}px`
              : 'clamp(352px, 33.333%, 50%)',
        } as CSSProperties
      }
      className={[
        'relative grid grid-cols-1 md:grid-cols-[1fr_var(--rail-w)]',
        // Text SELECTION is suppressed only while dragging — a drag across a
        // transcript otherwise selects it. Nothing is dimmed or frozen.
        dragging ? 'select-none' : '',
        // ⚠️ A STATIC CLASS, not an interpolated one. Tailwind scans source text,
        // so `duration-[${RAIL_RESET_DURATION_MS}ms]` emits no rule at all and the
        // reset would jump. `duration-200` IS `RAIL_RESET_DURATION_MS`, and the
        // test below pins the two together so they cannot drift apart.
        animating ? 'transition-[grid-template-columns] duration-200 ease-out' : '',
        className ?? 'h-dvh w-full',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {canvas}
      {chat}
      {/*
        ⚠️ ABSENT below `md`, not hidden and not disabled — there is no seam to
        drag, so there is no control. `containerPx === null` is the pre-measurement
        frame, where the CSS default is painting and a divider would have no
        container to clamp against.
      */}
      {splittable && containerPx !== null && bounds ? (
        <PlanningSplitDivider
          widthPx={valueNow}
          min={bounds.min}
          max={bounds.max}
          label={t('dividerAria')}
          dragging={dragging}
          onPointerDown={onPointerDown}
          onKeyDown={onKeyDown}
        />
      ) : null}
    </div>
  );
}
