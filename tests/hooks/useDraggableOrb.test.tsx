// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useDraggableOrb } from '@/lib/hooks/useDraggableOrb';

// The orb hook's TWO gesture signals, and why there are two (MOTIR-3226).
//
// `tests/components/plan-with-ai-fab-drag.test.tsx` owns what the user sees;
// this file owns the contract the component consumes, because the whole defect
// was a consumer reaching for the signal that looked right:
//
//   * `dragging` is FALSE for every frame of the throw — `up()` lowers it before
//     it calls `fling()`. That is correct for the grabbing CURSOR (the finger is
//     gone) and wrong for anything that must survive the release. MOTIR-3214 was
//     that mistake made with a CSS transition; MOTIR-3226 was the same mistake
//     one layer up, with the callout's `open` state.
//   * `moving` is the signal that covers BOTH phases: true from the frame travel
//     first crosses the drag threshold, and false only when `stepOrb` reports the
//     flight at rest.
//
// The assertions below pin the two apart at the exact instant they differ —
// `pointerup` — because a `moving` that merely aliased `dragging` would pass
// every other test in the tree.

const ORB = 56;
const HOME = { left: 1124, top: 724 };

/** The orb element the hook attaches to. happy-dom gives it no layout, so the
 *  corner the hook measures from is stubbed at the shipped bottom-right one. */
function orbElement(): HTMLButtonElement {
  const el = document.createElement('button');
  Object.defineProperty(el, 'offsetLeft', { value: HOME.left, configurable: true });
  Object.defineProperty(el, 'offsetTop', { value: HOME.top, configurable: true });
  document.body.appendChild(el);
  return el;
}

/** The offset the hook wrote, or `null` if it never painted. happy-dom leaves
 *  an unset `style.translate` UNDEFINED rather than empty, so read it through
 *  the same shape the component suite uses instead of comparing to `''`. */
function translateOf(el: HTMLElement): { x: number; y: number } | null {
  const m = /(-?[\d.]+)px\s+(-?[\d.]+)px/.exec(el.style.translate ?? '');
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}

function pointerEvent(
  type: string,
  init: { clientX: number; clientY: number; pointerId: number; timeStamp: number },
): Event {
  const ev = new Event(type);
  Object.defineProperties(ev, {
    clientX: { value: init.clientX },
    clientY: { value: init.clientY },
    pointerId: { value: init.pointerId },
    timeStamp: { value: init.timeStamp },
  });
  return ev;
}

/** `onPointerDown` reads four fields off the synthetic event and nothing else. */
function pressEvent(clientX: number, clientY: number): ReactPointerEvent<HTMLButtonElement> {
  return { button: 0, pointerId: 1, clientX, clientY } as ReactPointerEvent<HTMLButtonElement>;
}

let frames: FrameRequestCallback[] = [];
let clock = 1000;

beforeEach(() => {
  frames = [];
  clock = 1000;
  Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    onchange: null,
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Run one queued frame. Returns whether there was one to run. */
function stepFrame(): boolean {
  const cb = frames.shift();
  if (!cb) return false;
  clock += 16;
  act(() => cb(clock));
  return true;
}

describe('the orb hook’s MOVING signal', () => {
  it('spans the whole gesture — up at the threshold, still up across pointerup, down only at REST', () => {
    const { result } = renderHook(() => useDraggableOrb({ size: ORB }));
    const el = orbElement();
    act(() => result.current.attach(el));

    expect(result.current.moving).toBe(false);
    expect(result.current.dragging).toBe(false);

    // A press alone is not movement — it is how the callout is opened.
    act(() => result.current.onPointerDown(pressEvent(1150, 750)));
    expect(result.current.dragging).toBe(true);
    expect(result.current.moving).toBe(false);

    // The first move past `DRAG_THRESHOLD_PX` raises it.
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 900, clientY: 750, pointerId: 1, timeStamp: 16 }),
      );
    });
    expect(result.current.moving).toBe(true);

    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 600, clientY: 750, pointerId: 1, timeStamp: 32 }),
      );
    });

    // ⚠️ THE ASSERTION THE WHOLE SIGNAL EXISTS FOR. `pointerup` lowers `dragging`
    // and STARTS the flight — so the two signals disagree here, and a consumer
    // that had reached for `dragging` would act on "stopped" while the orb was
    // still crossing the viewport.
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointerup', { clientX: 600, clientY: 750, pointerId: 1, timeStamp: 48 }),
      );
    });
    expect(result.current.dragging).toBe(false);
    expect(result.current.moving).toBe(true);
    expect(frames.length).toBeGreaterThan(0);

    // It stays up for the flight's frames…
    expect(stepFrame()).toBe(true);
    expect(result.current.moving).toBe(true);

    // …and falls exactly once `stepOrb` reports resting, which is the frame that
    // stops asking for another one.
    let pumped = 0;
    while (stepFrame() && pumped < 2000) pumped++;
    expect(pumped).toBeGreaterThan(0);
    expect(frames).toHaveLength(0);
    expect(result.current.moving).toBe(false);
  });

  it('falls on pointerup when NO flight starts — reduced motion has nothing to wait for', () => {
    window.matchMedia = ((q: string) => ({
      matches: q.includes('reduce'),
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;

    const { result } = renderHook(() => useDraggableOrb({ size: ORB }));
    const el = orbElement();
    act(() => result.current.attach(el));

    act(() => result.current.onPointerDown(pressEvent(1150, 750)));
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 900, clientY: 750, pointerId: 1, timeStamp: 16 }),
      );
    });
    expect(result.current.moving).toBe(true);

    act(() => {
      window.dispatchEvent(
        pointerEvent('pointerup', { clientX: 900, clientY: 750, pointerId: 1, timeStamp: 32 }),
      );
    });
    // `fling` refuses under reduced motion, so the orb is already where it was
    // put — nothing will ever report it resting, and the release has to lower it.
    expect(frames).toHaveLength(0);
    expect(result.current.moving).toBe(false);
  });

  it('never rises for a press under the drag threshold', () => {
    const { result } = renderHook(() => useDraggableOrb({ size: ORB }));
    const el = orbElement();
    act(() => result.current.attach(el));

    act(() => result.current.onPointerDown(pressEvent(1150, 750)));
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 1152, clientY: 751, pointerId: 1, timeStamp: 16 }),
      );
    });
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointerup', { clientX: 1152, clientY: 751, pointerId: 1, timeStamp: 32 }),
      );
    });

    expect(result.current.moving).toBe(false);
    expect(translateOf(el)).toBeNull();
  });

  it('`dragging` keeps its pointerup semantics — the cursor class must not follow the throw', () => {
    const { result } = renderHook(() => useDraggableOrb({ size: ORB }));
    const el = orbElement();
    act(() => result.current.attach(el));

    act(() => result.current.onPointerDown(pressEvent(1150, 750)));
    expect(result.current.dragging).toBe(true);
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 600, clientY: 750, pointerId: 1, timeStamp: 16 }),
      );
      window.dispatchEvent(
        pointerEvent('pointerup', { clientX: 600, clientY: 750, pointerId: 1, timeStamp: 32 }),
      );
    });
    // A grabbing cursor on an orb nobody is holding is exactly what widening
    // `dragging` instead of adding `moving` would have shipped.
    expect(result.current.dragging).toBe(false);
  });
});

describe('onMoveStart', () => {
  it('fires ONCE per gesture, on the frame the orb starts moving', () => {
    const onMoveStart = vi.fn();
    const { result } = renderHook(() => useDraggableOrb({ size: ORB, onMoveStart }));
    const el = orbElement();
    act(() => result.current.attach(el));

    act(() => result.current.onPointerDown(pressEvent(1150, 750)));
    expect(onMoveStart).not.toHaveBeenCalled();

    // Three moves, one crossing — the consumer is told once, not per frame.
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 900, clientY: 750, pointerId: 1, timeStamp: 16 }),
      );
    });
    expect(onMoveStart).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 700, clientY: 750, pointerId: 1, timeStamp: 32 }),
      );
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 500, clientY: 750, pointerId: 1, timeStamp: 48 }),
      );
    });
    expect(onMoveStart).toHaveBeenCalledTimes(1);

    // A SECOND gesture is a second notification: the press lowers the signal
    // (catching a flying orb ends its flight), so the next drag raises it again.
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointerup', { clientX: 500, clientY: 750, pointerId: 1, timeStamp: 64 }),
      );
    });
    act(() => result.current.onPointerDown(pressEvent(500, 750)));
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 300, clientY: 700, pointerId: 1, timeStamp: 80 }),
      );
    });
    expect(onMoveStart).toHaveBeenCalledTimes(2);
  });

  it('is not required — the hook works without one', () => {
    const { result } = renderHook(() => useDraggableOrb({ size: ORB }));
    const el = orbElement();
    act(() => result.current.attach(el));

    act(() => result.current.onPointerDown(pressEvent(1150, 750)));
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 600, clientY: 750, pointerId: 1, timeStamp: 16 }),
      );
    });
    expect(result.current.moving).toBe(true);
    expect(translateOf(el)).not.toBeNull();
  });
});
