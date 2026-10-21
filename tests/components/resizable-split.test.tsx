// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { ResizableSplit } from '@/components/split/ResizableSplit';
import { __resetPersistedPaneWidthsForTests } from '@/lib/hooks/usePersistedPaneWidth';
import { defaultRailWidth, RAIL_KEYBOARD_STEP_PX } from '@/lib/planning/railWidth';

// MOTIR-9068 — the shared two-pane's own tier. Rendered DIRECTLY, with no intl
// provider: every string it shows is a prop, which is itself part of the contract.
//
// happy-dom lays nothing out, so the container is measured through a stubbed
// `ResizeObserver` and a `clientWidth` getter. That is the only thing faked.

const CONTAINER = 1440;
const CSS_DEFAULT = 'clamp(352px, 33.333%, 50%)';
const KEY_A = 'motir.test.splitA';
const KEY_B = 'motir.test.splitB';
const STACKED = 'grid-rows-[1fr_2fr] md:grid-rows-none';

let containerWidth = CONTAINER;
const observers = new Set<{ cb: ResizeObserverCallback; el: Element }>();

beforeAll(() => {
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Object.defineProperty(Element.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return (this as HTMLElement).dataset?.testid === 'resizable-split' ? containerWidth : 0;
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

function Pane({ label }: { label: string }) {
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

function Split(props: {
  storageKey?: string;
  resetWhen?: boolean;
  dividerLabel?: string;
  stackedRows?: string;
  left?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <ResizableSplit
      left={props.left ?? <Pane label="left" />}
      right={props.right ?? <Pane label="right" />}
      storageKey={props.storageKey ?? KEY_A}
      dividerLabel={props.dividerLabel ?? 'Resize the panes'}
      stackedRows={props.stackedRows ?? STACKED}
      resetWhen={props.resetWhen}
    />
  );
}

const frame = () => screen.getByTestId('resizable-split');
const divider = () => screen.getByTestId('split-divider');
const railVar = () => frame().style.getPropertyValue('--rail-w');

function dragTo(clientX: number) {
  fireEvent.pointerDown(divider(), { button: 0, pointerId: 1, clientX: 960 });
  act(() => {
    fireEvent.pointerMove(window, { pointerId: 1, clientX });
  });
  act(() => {
    fireEvent.pointerUp(window, { pointerId: 1, clientX });
  });
}

beforeEach(() => {
  containerWidth = CONTAINER;
  observers.clear();
  window.localStorage.clear();
  __resetPersistedPaneWidthsForTests();
});
afterEach(cleanup);

describe('the copy it is handed', () => {
  it('puts dividerLabel verbatim on the separator, with no intl provider', () => {
    render(<Split dividerLabel="A SENTINEL LABEL" />);
    resizeTo(1440);
    expect(screen.getByRole('separator', { name: 'A SENTINEL LABEL' })).toBeTruthy();
    expect(divider().getAttribute('aria-label')).toBe('A SENTINEL LABEL');
  });
});

describe('the storage key is the host’s', () => {
  it('does not share a width between two hosts, in either direction', () => {
    const first = render(<Split storageKey={KEY_A} />);
    resizeTo(1440);
    dragTo(900);
    expect(railVar()).toBe('540px');
    expect(window.localStorage.getItem(KEY_A)).toBe('540');
    first.unmount();

    // Host B mounts AFTER A has committed a width: it paints its OWN default.
    const second = render(<Split storageKey={KEY_B} />);
    expect(railVar()).toBe(CSS_DEFAULT);
    resizeTo(1440);
    expect(divider().getAttribute('aria-valuenow')).toBe(String(defaultRailWidth(1440)));
    dragTo(1000);
    expect(window.localStorage.getItem(KEY_B)).toBe('440');
    // ...and B's drag did not overwrite A's entry.
    expect(window.localStorage.getItem(KEY_A)).toBe('540');
    second.unmount();

    // And back: A reopens at what A chose, not at B's width.
    render(<Split storageKey={KEY_A} />);
    resizeTo(1440);
    expect(railVar()).toBe('540px');
  });

  it('two hosts mounted at once keep separate widths', () => {
    render(
      <div>
        <Split storageKey={KEY_A} left={<span>a-left</span>} right={<span>a-right</span>} />
        <Split storageKey={KEY_B} left={<span>b-left</span>} right={<span>b-right</span>} />
      </div>,
    );
    resizeTo(1440);
    const frames = screen.getAllByTestId('resizable-split');
    const dividers = screen.getAllByTestId('split-divider');
    expect(frames).toHaveLength(2);
    fireEvent.keyDown(dividers[0]!, { key: 'End' });
    expect(frames[0]!.style.getPropertyValue('--rail-w')).toBe('720px');
    expect(frames[1]!.style.getPropertyValue('--rail-w')).toBe(CSS_DEFAULT);
  });

  it('ignores a cross-tab storage event for another key', () => {
    render(<Split storageKey={KEY_A} />);
    resizeTo(1440);
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: KEY_B, newValue: '600' }));
    });
    expect(railVar()).toBe(CSS_DEFAULT);
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: KEY_A, newValue: '600' }));
    });
    expect(railVar()).toBe('600px');
  });
});

describe('a stored value that cannot be a width', () => {
  it.each(['not-a-number', '0', '-40', ''])('degrades %j to the CSS default, never to 0', (raw) => {
    window.localStorage.setItem(KEY_A, raw);
    __resetPersistedPaneWidthsForTests();
    render(<Split />);
    expect(railVar()).toBe(CSS_DEFAULT);
    resizeTo(1440);
    expect(railVar()).toBe(CSS_DEFAULT);
  });

  it('clamps a value above the current container’s maximum', () => {
    window.localStorage.setItem(KEY_A, '900');
    __resetPersistedPaneWidthsForTests();
    render(<Split />);
    resizeTo(1440);
    expect(railVar()).toBe('720px');
  });
});

describe('resetWhen', () => {
  it('leaves a dragged width alone across an unrelated re-render when omitted', () => {
    const { rerender } = render(<Split />);
    resizeTo(1440);
    dragTo(800);
    expect(railVar()).toBe('640px');
    rerender(<Split dividerLabel="Another label" />);
    expect(railVar()).toBe('640px');
  });

  it('returns to the default once on a false → true transition and keeps the stored width', () => {
    const { rerender } = render(<Split resetWhen={false} />);
    resizeTo(1440);
    dragTo(800);
    expect(railVar()).toBe('640px');
    rerender(<Split resetWhen />);
    expect(railVar()).toBe(`${defaultRailWidth(1440)}px`);
    expect(window.localStorage.getItem(KEY_A)).toBe('640');
    // One-shot: a later drag is not fought, and staying true does not re-fire.
    dragTo(800);
    rerender(<Split resetWhen />);
    expect(railVar()).toBe('640px');
  });

  it('is a no-op when the width is already at or below the default', () => {
    const { rerender } = render(<Split resetWhen={false} />);
    resizeTo(1440);
    fireEvent.keyDown(divider(), { key: 'Home' });
    const before = railVar();
    rerender(<Split resetWhen />);
    expect(railVar()).toBe(before);
    expect(window.localStorage.getItem(KEY_A)).toBe(String(before.replace('px', '')));
  });
});

describe('the shape it hands the host', () => {
  it('puts stackedRows on the frame root', () => {
    render(<Split stackedRows="grid-rows-[SENTINEL] md:grid-rows-none" />);
    expect(frame().className).toContain('grid-rows-[SENTINEL]');
    expect(frame().className).toContain('md:grid-rows-none');
  });

  it('renders left then right as the first two element children, unwrapped', () => {
    render(<Split left={<i data-testid="L" />} right={<b data-testid="R" />} />);
    resizeTo(1440);
    expect(frame().children[0]).toBe(screen.getByTestId('L'));
    expect(frame().children[1]).toBe(screen.getByTestId('R'));
  });

  it('re-mounts neither pane on a drag, a keyboard step or a container resize', () => {
    render(<Split />);
    resizeTo(1440);
    fireEvent.click(screen.getByText('bump left'));
    fireEvent.click(screen.getByText('bump right'));
    dragTo(800);
    fireEvent.keyDown(divider(), { key: 'ArrowLeft' });
    resizeTo(1600);
    expect(screen.getByTestId('count-left').textContent).toBe('1');
    expect(screen.getByTestId('count-right').textContent).toBe('1');
  });

  it('moves one keyboard step per arrow press', () => {
    render(<Split />);
    resizeTo(1440);
    const start = Number(divider().getAttribute('aria-valuenow'));
    fireEvent.keyDown(divider(), { key: 'ArrowLeft' });
    expect(Number(divider().getAttribute('aria-valuenow'))).toBe(start + RAIL_KEYBOARD_STEP_PX);
  });
});
