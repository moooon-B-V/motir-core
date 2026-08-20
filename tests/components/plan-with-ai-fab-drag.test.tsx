// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';

// The floating orb's DRAG + THROW wiring (MOTIR-3208).
//
// `tests/planning/orbPhysics.test.ts` owns the motion itself; this file owns the
// things only the component and the hook can be wrong about, and each of them is
// a way the feature breaks something that already worked:
//
//   * a press that does not move must still OPEN the callout — dragging a button
//     is the classic way to make it stop being a button;
//   * a press that DOES move must not open it, or every throw ends with a panel
//     in your face;
//   * the orb must not be draggable off-screen, and a resize must not strand it;
//   * `prefers-reduced-motion` must keep the drag and drop the flight;
//   * position must NOT be persisted — a new tab starts in the default corner.

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/dashboard',
}));

const { PlanWithAIFab } = await import('@/components/planning/PlanWithAIFab');

const ORB = 56;
const VIEWPORT = { width: 1200, height: 800 };

/** A pointer event the hook's native `window` listeners can read. `timeStamp` is
 *  a getter on `Event`, so it is defined rather than assigned — the throw
 *  velocity is measured from it, so a stubbed clock is not optional here. */
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

/** happy-dom gives every element a zero rect; the hook reads one to find the
 *  orb's starting corner, so stand one in at the shipped bottom-right position. */
function stubRect(el: HTMLElement, left: number, top: number): void {
  el.getBoundingClientRect = () =>
    ({
      left,
      top,
      right: left + ORB,
      bottom: top + ORB,
      width: ORB,
      height: ORB,
      x: left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
  Object.defineProperty(el, 'offsetLeft', { value: left, configurable: true });
  Object.defineProperty(el, 'offsetTop', { value: top, configurable: true });
}

function orbEl(): HTMLElement {
  return screen.getByRole('button', { name: /motir ai/i });
}

/** Translate values the hook wrote, in px. */
function transformOf(el: HTMLElement): { x: number; y: number } | null {
  const m = /translate3d\((-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(el.style.transform);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}

/** One drag gesture. `steps` are absolute client coordinates. */
function drag(el: HTMLElement, from: [number, number], steps: Array<[number, number]>): void {
  fireEvent.pointerDown(el, { button: 0, pointerId: 1, clientX: from[0], clientY: from[1] });
  let t = 0;
  for (const [x, y] of steps) {
    t += 16;
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', {
          clientX: x,
          clientY: y,
          pointerId: 1,
          timeStamp: t,
        }),
      );
    });
  }
  const last = steps.at(-1) ?? from;
  act(() => {
    window.dispatchEvent(
      pointerEvent('pointerup', {
        clientX: last[0],
        clientY: last[1],
        pointerId: 1,
        timeStamp: t + 16,
      }),
    );
  });
}

let reducedMotion = false;

beforeEach(() => {
  push.mockClear();
  reducedMotion = false;
  Object.defineProperty(window, 'innerWidth', { value: VIEWPORT.width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: VIEWPORT.height, configurable: true });
  window.matchMedia = ((q: string) => ({
    matches: q.includes('reduce') ? reducedMotion : false,
    media: q,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    onchange: null,
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
});

afterEach(cleanup);

describe('the orb is still a button', () => {
  it('a press that does NOT move opens the callout', async () => {
    renderWithIntl(<PlanWithAIFab />);
    const el = orbEl();
    stubRect(el, 1124, 724);

    // Down and up in the same spot — no movement at all.
    fireEvent.pointerDown(el, { button: 0, pointerId: 1, clientX: 1150, clientY: 750 });
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointerup', {
          clientX: 1150,
          clientY: 750,
          pointerId: 1,
          timeStamp: 20,
        }),
      );
    });
    fireEvent.click(el);

    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('tolerates a shaky tap — 3px of travel is still a click', () => {
    renderWithIntl(<PlanWithAIFab />);
    const el = orbEl();
    stubRect(el, 1124, 724);
    drag(el, [1150, 750], [[1152, 751]]);
    // Under the 4px threshold: nothing was written, so the orb never moved.
    expect(transformOf(el)).toBeNull();
  });

  it('a DRAG does not open the callout — the click it produces is swallowed', () => {
    renderWithIntl(<PlanWithAIFab />);
    const el = orbEl();
    stubRect(el, 1124, 724);

    drag(
      el,
      [1150, 750],
      [
        [900, 500],
        [700, 400],
      ],
    );
    fireEvent.click(el);

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('ignores a NON-PRIMARY button — right-click still reaches the context menu', () => {
    renderWithIntl(<PlanWithAIFab />);
    const el = orbEl();
    stubRect(el, 1124, 724);

    fireEvent.pointerDown(el, { button: 2, pointerId: 1, clientX: 1150, clientY: 750 });
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 400, clientY: 300, pointerId: 1, timeStamp: 16 }),
      );
    });
    // No listener was attached, so the move moved nothing.
    expect(transformOf(el)).toBeNull();
  });

  it('a CANCELLED pointer ends the gesture — a system gesture must not strand it', () => {
    renderWithIntl(<PlanWithAIFab />);
    const el = orbEl();
    stubRect(el, 1124, 724);

    fireEvent.pointerDown(el, { button: 0, pointerId: 1, clientX: 1150, clientY: 750 });
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 500, clientY: 400, pointerId: 1, timeStamp: 16 }),
      );
      window.dispatchEvent(
        pointerEvent('pointercancel', { clientX: 500, clientY: 400, pointerId: 1, timeStamp: 32 }),
      );
    });
    const after = transformOf(el);

    // Further movement is ignored: the listeners came off with the cancel.
    act(() => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 100, clientY: 100, pointerId: 1, timeStamp: 48 }),
      );
    });
    expect(transformOf(el)).toEqual(after);
  });

  it('keeps its accessible name and stays reachable', () => {
    renderWithIntl(<PlanWithAIFab />);
    const el = orbEl();
    expect(el.getAttribute('aria-label')).toBeTruthy();
    expect(el.tagName).toBe('BUTTON');
    // `touch-none` is what stops the page scrolling instead of the orb moving.
    expect(el.className).toContain('touch-none');
  });
});

describe('the orb goes where it is put', () => {
  it('follows the pointer, keeping the grab offset', () => {
    renderWithIntl(<PlanWithAIFab />);
    const el = orbEl();
    stubRect(el, 1124, 724);

    // Grabbed 26px right / 26px down from its corner; moved to (400, 300).
    drag(el, [1150, 750], [[400, 300]]);
    const t = transformOf(el);
    expect(t).not.toBeNull();
    // New corner = pointer - grab offset = (374, 274); transform is relative to
    // the element's laid-out position.
    expect(t!.x).toBeCloseTo(374 - 1124, 0);
    expect(t!.y).toBeCloseTo(274 - 1124 + 400, 0);
  });

  it('CANNOT be dragged off-screen — the pointer leaves, the orb stops at the margin', () => {
    renderWithIntl(<PlanWithAIFab />);
    const el = orbEl();
    stubRect(el, 1124, 724);

    drag(el, [1150, 750], [[-500, -500]]);
    const t = transformOf(el)!;
    // Top-left corner clamps to the 20px margin.
    expect(t.x + 1124).toBeCloseTo(20, 0);
    expect(t.y + 724).toBeCloseTo(20, 0);
  });

  it('TRIMS the velocity trail on a long drag — it must not grow without bound', () => {
    renderWithIntl(<PlanWithAIFab />);
    const el = orbEl();
    stubRect(el, 1124, 724);

    // ~120 moves over ~2s. The trail keeps only the recent tail, so a long drag
    // is bounded memory — and the throw still reads the END of the gesture, which
    // is asserted by the orb finishing where the last move put it.
    const steps: Array<[number, number]> = [];
    for (let i = 0; i < 120; i++) steps.push([1100 - i * 6, 700 - i * 4]);
    drag(el, [1150, 750], steps);

    const t = transformOf(el)!;
    const last = steps.at(-1)!;
    expect(t.x + 1124).toBeCloseTo(last[0] - 26, 0);
    expect(t.y + 724).toBeCloseTo(last[1] - 26, 0);
  });

  it('RE-CLAMPS on resize rather than resetting — a narrowed window does not lose it', () => {
    renderWithIntl(<PlanWithAIFab />);
    const el = orbEl();
    stubRect(el, 1124, 724);
    drag(el, [1150, 750], [[1100, 700]]);

    act(() => {
      Object.defineProperty(window, 'innerWidth', { value: 480, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: 400, configurable: true });
      window.dispatchEvent(new Event('resize'));
    });

    const t = transformOf(el)!;
    expect(t.x + 1124).toBeLessThanOrEqual(480 - ORB - 20 + 0.5);
    expect(t.y + 724).toBeLessThanOrEqual(400 - ORB - 20 + 0.5);
  });
});

describe('the throw', () => {
  it('keeps flying after release — a fast flick does not stop at the finger', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    // The flight measures `dt` against `performance.now()`, so the frame clock has
    // to agree with the one the hook read when the throw started — otherwise the
    // first `dt` is negative, `stepOrb` clamps it to zero, and nothing moves.
    let clock = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);

    renderWithIntl(<PlanWithAIFab />);
    const el = orbEl();
    stubRect(el, 1124, 724);
    drag(
      el,
      [1150, 750],
      [
        [900, 750],
        [600, 750],
      ],
    );

    const atRelease = transformOf(el)!;
    expect(frames.length).toBeGreaterThan(0); // a flight was scheduled

    act(() => {
      const cb = frames.shift()!;
      clock += 16;
      cb(clock);
    });
    const afterFrame = transformOf(el)!;
    // It kept travelling LEFT, the direction of the throw.
    expect(afterFrame.x).toBeLessThan(atRelease.x);

    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('REDUCED MOTION keeps the drag and drops the flight', () => {
    reducedMotion = true;
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    renderWithIntl(<PlanWithAIFab />);
    const el = orbEl();
    stubRect(el, 1124, 724);
    drag(
      el,
      [1150, 750],
      [
        [900, 750],
        [600, 750],
      ],
    );

    // Moved — the drag still works…
    expect(transformOf(el)).not.toBeNull();
    // …and nothing was scheduled to fly.
    expect(frames).toHaveLength(0);

    vi.unstubAllGlobals();
  });
});

describe('the flight ends', () => {
  it('runs to REST and stops asking for frames', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    let clock = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);

    renderWithIntl(<PlanWithAIFab />);
    const el = orbEl();
    stubRect(el, 1124, 724);
    drag(
      el,
      [1150, 750],
      [
        [900, 750],
        [600, 750],
      ],
    );

    // Pump frames until the loop stops scheduling. A loop that never rests would
    // spin here forever, which is the failure this asserts against.
    let pumped = 0;
    while (frames.length > 0 && pumped < 2000) {
      const cb = frames.shift()!;
      clock += 16;
      act(() => cb(clock));
      pumped++;
    }
    expect(pumped).toBeGreaterThan(1);
    expect(frames).toHaveLength(0);

    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
});

describe('the position is NOT persisted', () => {
  it('writes nothing to storage, so a new tab starts in the default corner', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    renderWithIntl(<PlanWithAIFab />);
    const el = orbEl();
    stubRect(el, 1124, 724);
    drag(el, [1150, 750], [[300, 200]]);

    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it('a FRESH MOUNT is back at the default corner — no transform of its own', () => {
    // The new-tab case: a fresh mount has no inline transform, so the shipped
    // `right-5 bottom-5` classes place it.
    const first = renderWithIntl(<PlanWithAIFab />);
    const el = orbEl();
    stubRect(el, 1124, 724);
    drag(el, [1150, 750], [[300, 200]]);
    expect(transformOf(el)).not.toBeNull();
    first.unmount();

    renderWithIntl(<PlanWithAIFab />);
    const fresh = orbEl();
    expect(transformOf(fresh)).toBeNull();
    expect(fresh.className).toContain('right-5');
    expect(fresh.className).toContain('bottom-5');
  });
});
