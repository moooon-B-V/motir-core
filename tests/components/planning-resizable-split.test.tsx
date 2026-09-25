// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { PlanningWorkspace } from '@/components/planning/PlanningWorkspace';
import { PLANNING_FRAME_STACKED_ROWS } from '@/components/planning/planningFrameRows';
import { __resetPlanningRailWidthForTests } from '@/lib/hooks/usePlanningRailWidth';
import {
  defaultRailWidth,
  railBounds,
  RAIL_KEYBOARD_COARSE_STEP_PX,
  RAIL_KEYBOARD_STEP_PX,
  RAIL_MIN_PX,
  RAIL_WIDTH_STORAGE_KEY,
} from '@/lib/planning/railWidth';

// MOTIR-6250 — the resizable planning split, against MOTIR-6249's approved design.
//
// ── HOW THE CONTAINER IS MEASURED IN happy-dom ──────────────────────────────
// happy-dom lays nothing out, so `clientWidth` is 0 and `ResizeObserver` does not
// exist. The frame reads its container through both, so the harness supplies them:
// a stubbed `ResizeObserver` that reports a width we control, and a `clientWidth`
// getter. That is the ONLY thing faked — the clamp, the reset, the keyboard path
// and the persistence are the real ones.

const CONTAINER = 1440;
let containerWidth = CONTAINER;
const observers = new Set<{ cb: ResizeObserverCallback; el: Element }>();

beforeAll(() => {
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;

  Object.defineProperty(Element.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return (this as HTMLElement).dataset?.testid === 'planning-resizable-frame'
        ? containerWidth
        : 0;
    },
  });

  class RO implements ResizeObserver {
    constructor(private cb: ResizeObserverCallback) {}
    observe(el: Element) {
      observers.add({ cb: this.cb, el });
    }
    unobserve() {}
    disconnect() {
      for (const o of observers) if (o.cb === this.cb) observers.delete(o);
    }
  }
  globalThis.ResizeObserver = RO as unknown as typeof ResizeObserver;

  // `requestAnimationFrame` drives the drag's coalescing; run it synchronously so
  // a `pointermove` is observable in the same act scope.
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;

  globalThis.matchMedia ??= ((q: string) =>
    ({
      matches: false,
      media: q,
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaQueryList) as typeof matchMedia;
});

/** Push a container width through the stubbed observer. */
function resizeTo(width: number) {
  containerWidth = width;
  act(() => {
    for (const o of observers) {
      o.cb(
        [{ contentRect: { width } } as unknown as ResizeObserverEntry],
        null as unknown as ResizeObserver,
      );
    }
  });
}

/** A pane that owns state, so a re-mount is OBSERVABLE rather than assumed. */
function StatefulPane({ label }: { label: string }) {
  const [n, setN] = useState(0);
  return (
    <div>
      <button type="button" onClick={() => setN((v) => v + 1)}>
        bump {label}
      </button>
      <span data-testid={`count-${label}`}>{n}</span>
    </div>
  );
}

function renderSplit(props: { proposalPresent?: boolean } = {}) {
  return render(
    <PlanningWorkspace
      resizable
      proposalPresent={props.proposalPresent ?? false}
      canvas={<StatefulPane label="canvas" />}
      chat={<StatefulPane label="chat" />}
    />,
  );
}

const frame = () => screen.getByTestId('planning-resizable-frame');
const divider = () => screen.getByTestId('planning-split-divider');
const railVar = () => frame().style.getPropertyValue('--rail-w');

beforeEach(() => {
  containerWidth = CONTAINER;
  observers.clear();
  window.localStorage.clear();
  __resetPlanningRailWidthForTests();
});
afterEach(cleanup);

describe('the DEFAULT share on mount', () => {
  it('leaves the width to CSS until one has been chosen — no JS pin', () => {
    renderSplit();
    // The default is a pure CSS expression, so the first paint is correct at every
    // viewport with no measurement. Pinning a pixel value here would stop the pane
    // following the container as the window resizes.
    expect(railVar()).toBe('clamp(352px, 33.333%, 50%)');
  });

  it('reports the default as `aria-valuenow` once the container is measured', () => {
    renderSplit();
    resizeTo(1440);
    expect(divider().getAttribute('aria-valuenow')).toBe(String(defaultRailWidth(1440)));
    expect(divider().getAttribute('aria-valuemin')).toBe(String(RAIL_MIN_PX));
    expect(divider().getAttribute('aria-valuemax')).toBe('720');
  });
});

describe('the divider’s accessibility contract', () => {
  it('is a focusable separator with an orientation and a name', () => {
    renderSplit();
    resizeTo(1440);
    const d = divider();
    expect(d.getAttribute('role')).toBe('separator');
    expect(d.getAttribute('aria-orientation')).toBe('vertical');
    expect(d.getAttribute('tabindex')).toBe('0');
    expect(d.getAttribute('aria-label')).toBeTruthy();
    // The name comes from the catalogue, not a literal in the component.
    expect(d.getAttribute('aria-label')).toBe('Resize the conversation');
  });
});

describe('a POINTER drag', () => {
  it('moves both panes together and commits where it was dropped', () => {
    renderSplit();
    resizeTo(1440);
    // The frame's right edge is the container's; happy-dom gives a zero rect, so
    // the component falls back to the measured width, which is what we assert on.
    fireEvent.pointerDown(divider(), { button: 0, pointerId: 1, clientX: 960 });
    act(() => {
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 900 });
    });
    // The conversation is the RIGHT pane: its width is (right edge − pointer).
    expect(railVar()).toBe('540px');
    act(() => {
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 900 });
    });
    expect(railVar()).toBe('540px');
    expect(window.localStorage.getItem(RAIL_WIDTH_STORAGE_KEY)).toBe('540');
  });

  it('holds each bound — the pointer may keep travelling with no further effect', () => {
    renderSplit();
    resizeTo(1440);
    const { max } = railBounds(1440);
    fireEvent.pointerDown(divider(), { button: 0, pointerId: 1, clientX: 960 });
    act(() => {
      fireEvent.pointerMove(window, { pointerId: 1, clientX: -5000 });
    });
    expect(railVar()).toBe(`${max}px`);
    act(() => {
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 99999 });
    });
    expect(railVar()).toBe(`${RAIL_MIN_PX}px`);
    // Releasing OUTSIDE the bounds commits the bound, not the pointer.
    act(() => {
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 99999 });
    });
    expect(window.localStorage.getItem(RAIL_WIDTH_STORAGE_KEY)).toBe(String(RAIL_MIN_PX));
  });

  it('ignores a non-primary button', () => {
    renderSplit();
    resizeTo(1440);
    fireEvent.pointerDown(divider(), { button: 2, pointerId: 1, clientX: 960 });
    act(() => {
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 700 });
    });
    expect(railVar()).toBe('clamp(352px, 33.333%, 50%)');
  });
});

describe('the KEYBOARD path', () => {
  it('moves the DIVIDER by one step per arrow — left widens the conversation', () => {
    renderSplit();
    resizeTo(1440);
    const start = defaultRailWidth(1440);
    fireEvent.keyDown(divider(), { key: 'ArrowLeft' });
    expect(railVar()).toBe(`${start + RAIL_KEYBOARD_STEP_PX}px`);
    fireEvent.keyDown(divider(), { key: 'ArrowRight' });
    expect(railVar()).toBe(`${start}px`);
  });

  it('takes the coarse step with Shift', () => {
    renderSplit();
    resizeTo(1440);
    const start = defaultRailWidth(1440);
    fireEvent.keyDown(divider(), { key: 'ArrowLeft', shiftKey: true });
    expect(railVar()).toBe(`${start + RAIL_KEYBOARD_COARSE_STEP_PX}px`);
  });

  it('goes to the bounds on Home / End and back to the default on Enter', () => {
    renderSplit();
    resizeTo(1440);
    fireEvent.keyDown(divider(), { key: 'Home' });
    expect(railVar()).toBe(`${RAIL_MIN_PX}px`);
    fireEvent.keyDown(divider(), { key: 'End' });
    expect(railVar()).toBe('720px');
    fireEvent.keyDown(divider(), { key: 'Enter' });
    expect(railVar()).toBe(`${defaultRailWidth(1440)}px`);
  });

  it('persists what the keyboard commits, and leaves other keys alone', () => {
    renderSplit();
    resizeTo(1440);
    fireEvent.keyDown(divider(), { key: 'Home' });
    expect(window.localStorage.getItem(RAIL_WIDTH_STORAGE_KEY)).toBe(String(RAIL_MIN_PX));
    fireEvent.keyDown(divider(), { key: 'a' });
    expect(railVar()).toBe(`${RAIL_MIN_PX}px`);
  });
});

describe('the RESET when a plan is proposed', () => {
  it('returns the canvas to two-thirds, and does NOT clear the stored width', () => {
    const view = renderSplit({ proposalPresent: false });
    resizeTo(1440);
    fireEvent.keyDown(divider(), { key: 'End' }); // drag the conversation to 720
    expect(railVar()).toBe('720px');

    view.rerender(
      <PlanningWorkspace
        resizable
        proposalPresent
        canvas={<StatefulPane label="canvas" />}
        chat={<StatefulPane label="chat" />}
      />,
    );

    expect(railVar()).toBe(`${defaultRailWidth(1440)}px`);
    // The person's chosen width is still theirs — the reset is a one-shot return
    // for reading THIS plan, not a forgetting.
    expect(window.localStorage.getItem(RAIL_WIDTH_STORAGE_KEY)).toBe('720');
  });

  it('fires ONCE — a later re-render with a proposal still present does not re-reset', () => {
    const view = renderSplit({ proposalPresent: false });
    resizeTo(1440);
    const withProposal = (
      <PlanningWorkspace
        resizable
        proposalPresent
        canvas={<StatefulPane label="canvas" />}
        chat={<StatefulPane label="chat" />}
      />
    );
    fireEvent.keyDown(divider(), { key: 'End' });
    view.rerender(withProposal);
    expect(railVar()).toBe(`${defaultRailWidth(1440)}px`);

    // Widen again WHILE the proposal is on screen, then re-render. A reset that
    // keyed on the value rather than the transition would fight the person here.
    fireEvent.keyDown(divider(), { key: 'End' });
    expect(railVar()).toBe('720px');
    view.rerender(withProposal);
    expect(railVar()).toBe('720px');
  });

  it('is a NO-OP at or below the default', () => {
    const view = renderSplit({ proposalPresent: false });
    resizeTo(1440);
    fireEvent.keyDown(divider(), { key: 'Home' }); // 352, below the default
    view.rerender(
      <PlanningWorkspace
        resizable
        proposalPresent
        canvas={<StatefulPane label="canvas" />}
        chat={<StatefulPane label="chat" />}
      />,
    );
    expect(railVar()).toBe(`${RAIL_MIN_PX}px`);
  });
});

describe('PERSISTENCE', () => {
  it('restores a stored width, CLAMPED into the current container', () => {
    window.localStorage.setItem(RAIL_WIDTH_STORAGE_KEY, '900');
    __resetPlanningRailWidthForTests();
    renderSplit();
    resizeTo(1440); // 900 is above this container's 720 maximum
    expect(railVar()).toBe('720px');
  });

  it('treats a corrupt stored value as never-dragged rather than as a width', () => {
    window.localStorage.setItem(RAIL_WIDTH_STORAGE_KEY, 'not-a-number');
    __resetPlanningRailWidthForTests();
    renderSplit();
    expect(railVar()).toBe('clamp(352px, 33.333%, 50%)');
  });
});

describe('what a resize must NOT do', () => {
  it('does not re-mount either pane — their own state survives every path', () => {
    renderSplit();
    resizeTo(1440);
    fireEvent.click(screen.getByRole('button', { name: 'bump canvas' }));
    fireEvent.click(screen.getByRole('button', { name: 'bump chat' }));
    expect(screen.getByTestId('count-canvas').textContent).toBe('1');
    expect(screen.getByTestId('count-chat').textContent).toBe('1');

    // A drag, the keyboard, a container resize and the reset — every width path.
    fireEvent.pointerDown(divider(), { button: 0, pointerId: 1, clientX: 960 });
    act(() => {
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 800 });
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 800 });
    });
    fireEvent.keyDown(divider(), { key: 'ArrowLeft' });
    resizeTo(1280);

    // This is the STRUCTURAL guarantee the card's criterion is about: the panes are
    // `ReactNode` children rendered in the same position on every width, so nothing
    // re-keys and nothing is swapped for a placeholder. A prop-seeded island can
    // only lose its state by re-mounting, and this frame cannot re-mount one.
    expect(screen.getByTestId('count-canvas').textContent).toBe('1');
    expect(screen.getByTestId('count-chat').textContent).toBe('1');
  });
});

describe('the NARROW viewport', () => {
  it('renders NO divider below `md` — absent, not hidden', () => {
    renderSplit();
    resizeTo(720);
    expect(screen.queryByTestId('planning-split-divider')).toBeNull();
  });

  it('gives the STACK an explicit row template, and hands the split back its own rows at `md`', () => {
    // jsdom does no layout, so the geometry — the canvas keeping a real height under
    // a full transcript — is proven in `tests/e2e/planning-anchor-level.spec.ts`
    // (MOTIR-6276). This pins the two halves of the class that makes it true: the
    // `fr` rows below the breakpoint, and their reset above it.
    renderSplit();
    const frame = screen.getByTestId('planning-resizable-frame');
    expect(frame.className).toContain('grid-rows-[minmax(0,3fr)_minmax(12rem,2fr)]');
    expect(frame.className).toContain('md:grid-rows-none');
  });

  it('brings it back, and leaves a stored width untouched across the boundary', () => {
    renderSplit();
    resizeTo(1440);
    fireEvent.keyDown(divider(), { key: 'End' });
    expect(window.localStorage.getItem(RAIL_WIDTH_STORAGE_KEY)).toBe('720');
    resizeTo(700);
    expect(screen.queryByTestId('planning-split-divider')).toBeNull();
    expect(window.localStorage.getItem(RAIL_WIDTH_STORAGE_KEY)).toBe('720');
    resizeTo(1440);
    expect(screen.getByTestId('planning-split-divider')).toBeTruthy();
  });
});

describe('the OPT-IN boundary — four other consumers keep the fixed frame', () => {
  it('renders the shipped fixed grid, and no divider, without `resizable`', () => {
    render(<PlanningWorkspace canvas={<div>canvas</div>} chat={<div>chat</div>} />);
    expect(screen.queryByTestId('planning-resizable-frame')).toBeNull();
    expect(screen.queryByTestId('planning-split-divider')).toBeNull();
    // The two-column track `PlanDetail`, `GenerationFlow`, `DiscoveryOnboarding`
    // and `PlanningWorkspaceSkeleton` have always had at and above `md`.
    expect(document.querySelector('.md\\:grid-cols-\\[1fr_22rem\\]')).toBeTruthy();
  });

  it('gives the fixed frame the SAME stacked row template as the resizable one (MOTIR-6281)', () => {
    // Below `md` the fixed frame stacked in implicit `auto` rows, and the plan page's
    // canvas measured 0px at 767×720 — the geometry is proven in
    // `tests/e2e/plan-detail-narrow.spec.ts`. This pins that both frames read ONE
    // constant, so the stack cannot be fixed on one frame and drift on the other.
    const { unmount } = render(<PlanningWorkspace canvas={<div />} chat={<div />} />);
    const fixed = screen.getByTestId('planning-workspace-frame');
    for (const cls of PLANNING_FRAME_STACKED_ROWS.split(' ')) {
      expect(fixed.classList.contains(cls)).toBe(true);
    }
    expect(fixed.classList.contains('md:grid-cols-[1fr_22rem]')).toBe(true);
    unmount();
    renderSplit();
    const resizable = screen.getByTestId('planning-resizable-frame');
    for (const cls of PLANNING_FRAME_STACKED_ROWS.split(' ')) {
      expect(resizable.classList.contains(cls)).toBe(true);
    }
  });

  it('still renders the guard overlay on both paths', () => {
    const { unmount } = render(
      <PlanningWorkspace canvas={<div />} chat={<div />} guard={<div>guard</div>} />,
    );
    expect(screen.getByText('guard')).toBeTruthy();
    unmount();
    render(
      <PlanningWorkspace resizable canvas={<div />} chat={<div />} guard={<div>guard</div>} />,
    );
    expect(screen.getByText('guard')).toBeTruthy();
  });
});

describe('the page-state contract', () => {
  it('never calls `router.refresh()` — a resize is a client-island concern', async () => {
    // Asserted STRUCTURALLY rather than with a spy: the frame does not import
    // `next/navigation` at all, so there is no refresh it could call.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('components/planning/PlanningResizableFrame.tsx', 'utf8'),
    );
    expect(source).not.toMatch(/next\/navigation/);
    expect(source).not.toMatch(/router\.refresh|revalidatePath/);
  });
});
