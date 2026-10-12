// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeroWaves } from '@/components/brand/HeroWaves';

// MOTIR-8256 (Story MOTIR-8238's integration gate), case 4 — the hero waves'
// canvas loop, driven through its branches with a STUBBED canvas context,
// `IntersectionObserver`, `ResizeObserver`, `matchMedia` and animation frame.
// happy-dom has no 2D canvas, so nothing here draws: the stub records the calls,
// which is what tells the branches apart (a still field draws once, an off-screen
// one stops asking for frames, a field with no focus draws nothing).

interface FakeCtx {
  calls: string[];
  fillStyle: string;
  strokeStyle: unknown;
  lineWidth: number;
  globalAlpha: number;
  filter?: string;
  [k: string]: unknown;
}

/** A recording 2D context. `fillStyle` normalises the way a canvas does: the
 *  value read back is whatever `normalise` maps the written colour to. */
function fakeContext(opts: { filter?: boolean; normalise?: (c: string) => string } = {}): FakeCtx {
  const calls: string[] = [];
  let fill = '';
  const ctx: FakeCtx = {
    calls,
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    get fillStyle() {
      return fill;
    },
    set fillStyle(c: string) {
      fill = opts.normalise ? opts.normalise(c) : c;
    },
  };
  for (const m of [
    'setTransform',
    'clearRect',
    'save',
    'restore',
    'stroke',
    'beginPath',
    'moveTo',
    'lineTo',
    'fillRect',
  ]) {
    ctx[m] = (...a: unknown[]) => {
      calls.push(m);
      return a;
    };
  }
  ctx.createLinearGradient = () => ({ addColorStop: () => calls.push('addColorStop') });
  if (opts.filter !== false) ctx.filter = 'none';
  return ctx;
}

const TOKENS: Record<string, string> = {
  '--el-showcase-wave-1': '#5b4bdb',
  '--el-showcase-wave-2': '#1a9e8f',
  '--el-showcase-wave-3': '#ef7d3c',
  '--el-showcase-decision': '#123456',
  '--el-showcase-highlight': 'rgb(10, 20, 30)',
  '--el-showcase-ground': 'color(srgb 0.1 0.2 0.3)',
};

let tokens: Record<string, string>;
let ctx: FakeCtx | null;
let reduced: boolean;
let rafQueue: Array<(t: number) => void>;
let seenCallback: ((entries: Array<{ isIntersecting: boolean } | undefined>) => void) | null;
let resizeCallback: (() => void) | null;
const cancelled: number[] = [];

beforeEach(() => {
  tokens = { ...TOKENS };
  ctx = fakeContext();
  reduced = false;
  rafQueue = [];
  seenCallback = null;
  resizeCallback = null;
  cancelled.length = 0;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => ctx as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(window, 'getComputedStyle').mockImplementation(
    () => ({ getPropertyValue: (n: string) => tokens[n] ?? '' }) as unknown as CSSStyleDeclaration,
  );
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduced, media: q }));
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => cancelled.push(id));
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(cb: typeof seenCallback) {
        seenCallback = cb;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) {
        resizeCallback = cb;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'Path2D',
    class {
      moveTo() {}
      lineTo() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-theme');
});

/** The host the canvas measures: a sized box, a header to keep clear, a focus. */
function mount(opts: { focusId?: string | null; withFocus?: boolean } = {}) {
  const r = render(
    <div data-testid="host">
      <header>bar</header>
      {opts.withFocus === false ? null : <div id="hero-control">control</div>}
      <HeroWaves {...(opts.focusId === null ? {} : { focusId: opts.focusId ?? 'hero-control' })} />
    </div>,
  );
  return r;
}

// The host's size is read from `clientWidth` / `clientHeight`, which happy-dom
// reports as 0; patch the prototype getters for the duration of a test.
function sizeHosts(width: number, height = 640) {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(height);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.id === 'hero-control')
      return { left: 400, top: 280, width: 400, height: 80 } as DOMRect;
    if (this.tagName === 'HEADER') return { left: 0, top: 0, width, height: 60 } as DOMRect;
    return { left: 0, top: 0, width, height } as DOMRect;
  });
}

function runFrame(now: number) {
  const cb = rafQueue.shift();
  act(() => cb?.(now));
}

describe('HeroWaves', () => {
  it('is a decorative canvas naming its focus, and the auth card by default', () => {
    ctx = null;
    const { container } = mount({ focusId: null });
    const canvas = container.querySelector('canvas')!;
    expect(canvas.getAttribute('aria-hidden')).toBe('true');
    expect(canvas.dataset.focusId).toBe('auth-card');
  });

  it('draws nothing and starts nothing without a 2D context', () => {
    ctx = null;
    mount();
    expect(rafQueue).toHaveLength(0);
  });

  it('animates: lines, glow, touches and squares, throttled to its frame budget', () => {
    sizeHosts(1200);
    const live = ctx!;
    mount();
    // The first refresh draws a frame at once and asks for the next one.
    expect(live.calls).toContain('clearRect');
    expect(live.calls).toContain('fillRect');
    expect(live.filter).toBe('blur(4px)');
    expect(rafQueue).toHaveLength(1);
    live.calls.length = 0;
    runFrame(100_000);
    expect(live.calls).toContain('stroke');
    // A frame inside the budget draws nothing and still asks for the next one.
    live.calls.length = 0;
    runFrame(100_001);
    expect(live.calls).not.toContain('clearRect');
    expect(rafQueue).toHaveLength(1);
  });

  it('reads the dark theme, and skips the blur where the canvas has no filter', () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    ctx = fakeContext({ filter: false });
    sizeHosts(1200);
    mount();
    expect(ctx.calls).toContain('stroke');
    expect('filter' in ctx).toBe(false);
  });

  it('under reduced motion draws once and stays still', () => {
    reduced = true;
    sizeHosts(1200);
    mount();
    expect(ctx!.calls).toContain('clearRect');
    expect(rafQueue).toHaveLength(0);
  });

  it('stops asking for frames off screen and resumes when seen again', () => {
    sizeHosts(1200);
    mount();
    act(() => seenCallback?.([{ isIntersecting: false }]));
    runFrame(200_000);
    expect(rafQueue).toHaveLength(0);
    act(() => seenCallback?.([{ isIntersecting: true }]));
    expect(rafQueue).toHaveLength(1);
    // An observer entry that is missing reads as visible.
    act(() => seenCallback?.([undefined]));
    expect(rafQueue).toHaveLength(1);
  });

  it('pauses while the tab is hidden and resumes on visibilitychange', () => {
    sizeHosts(1200);
    mount();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    runFrame(300_000);
    expect(rafQueue).toHaveLength(0);
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(rafQueue).toHaveLength(0);
    hidden.mockReturnValue(false);
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(rafQueue).toHaveLength(1);
  });

  it('draws nothing when its focus element is missing', () => {
    sizeHosts(1200);
    mount({ withFocus: false });
    expect(ctx!.calls).not.toContain('clearRect');
  });

  it('draws nothing at zero width', () => {
    sizeHosts(0);
    mount();
    expect(ctx!.calls).not.toContain('clearRect');
  });

  it('draws nothing when a wave hue does not resolve', () => {
    tokens['--el-showcase-wave-2'] = '';
    sizeHosts(1200);
    mount();
    expect(ctx!.calls).not.toContain('clearRect');
  });

  it('skips the touches and squares whose inks do not resolve', () => {
    tokens['--el-showcase-decision'] = '';
    tokens['--el-showcase-highlight'] = '';
    sizeHosts(1200);
    mount();
    expect(ctx!.calls).toContain('clearRect');
    expect(ctx!.calls).not.toContain('fillRect');
  });

  it('fades each touch ink whatever colour syntax the canvas normalises it to', () => {
    for (const normalise of [
      (c: string) => (c === 'transparent' ? 'rgba(0, 0, 0, 0)' : '#102030'),
      (c: string) => (c === 'transparent' ? 'rgba(0, 0, 0, 0)' : 'rgb(1, 2, 3)'),
      (c: string) => (c === 'transparent' ? 'rgba(0, 0, 0, 0)' : 'color(srgb 0.1 0.2 0.3)'),
      (c: string) => (c === 'transparent' ? 'rgba(0, 0, 0, 0)' : 'oklch(0.5 0.1 200)'),
    ]) {
      ctx = fakeContext({ normalise });
      sizeHosts(1200);
      mount();
      expect(ctx.calls).toContain('addColorStop');
      cleanup();
      vi.restoreAllMocks();
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
        () => ctx as unknown as CanvasRenderingContext2D,
      );
      vi.spyOn(window, 'getComputedStyle').mockImplementation(
        () =>
          ({ getPropertyValue: (n: string) => tokens[n] ?? '' }) as unknown as CSSStyleDeclaration,
      );
    }
  });

  it('re-measures after a resize settles, and on a theme change', async () => {
    vi.useFakeTimers();
    try {
      sizeHosts(1200);
      mount();
      ctx!.calls.length = 0;
      act(() => resizeCallback?.());
      act(() => {
        vi.advanceTimersByTime(130);
      });
      expect(ctx!.calls).toContain('setTransform');
      ctx!.calls.length = 0;
      await act(async () => {
        document.documentElement.setAttribute('data-palette', 'cobalt');
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(ctx!.calls).toContain('setTransform');
    } finally {
      document.documentElement.removeAttribute('data-palette');
      vi.useRealTimers();
    }
  });

  it('cancels its pending frame when it unmounts', () => {
    sizeHosts(1200);
    const { unmount } = mount();
    expect(rafQueue).toHaveLength(1);
    unmount();
    expect(cancelled).toHaveLength(1);
  });

  it('falls back to a device pixel ratio of 1', () => {
    vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(0);
    sizeHosts(1000);
    const { container } = mount();
    expect(container.querySelector('canvas')!.width).toBe(1000);
  });
});
