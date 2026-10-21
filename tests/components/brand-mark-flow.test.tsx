// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BrandMark } from '@/components/brand/BrandMark';
import { BrandMarkFlow } from '@/components/brand/BrandMarkFlow';
import { WAVE_BAND_PATH } from '@/components/brand/waveBand';
import { FLOW_EASE_MS } from '@/components/brand/waveBandFlow';

// MOTIR-9213 — the Motir mark that flows while Motir AI works (design
// `design/ai-chat/design-notes.md` § _The Motir mark at work_). At rest it is the
// shipped inverted glyph; flowing, a frame loop rewrites the path; the loop never
// runs under reduced motion, and pauses while the tab is hidden or the mark is off
// screen. The frame loop is driven by hand here: `requestAnimationFrame` is a queue
// this file flushes with a timestamp of its choosing.

let queue: Map<number, FrameRequestCallback>;
let nextId: number;
let now: number;
let reduce: boolean;
let observers: { cb: IntersectionObserverCallback; target: Element | null }[];

function stubMedia(present = true) {
  if (!present) {
    vi.stubGlobal('matchMedia', undefined);
    return;
  }
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('reduce') ? reduce : !reduce,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

beforeEach(() => {
  queue = new Map();
  nextId = 1;
  now = 1_000;
  reduce = false;
  observers = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextId++;
    queue.set(id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => queue.delete(id));
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      private entry: { cb: IntersectionObserverCallback; target: Element | null };
      constructor(cb: IntersectionObserverCallback) {
        this.entry = { cb, target: null };
        observers.push(this.entry);
      }
      observe(target: Element) {
        this.entry.target = target;
      }
      disconnect() {}
    },
  );
  stubMedia();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});

/** Run every queued frame `ms` later than the last one. */
function frame(ms = 16) {
  now += ms;
  const callbacks = [...queue.values()];
  queue.clear();
  act(() => {
    for (const cb of callbacks) cb(now);
  });
}

const path = () => document.querySelector('path')!;
const gradient = () => document.querySelector('linearGradient');

describe('at rest', () => {
  it('is the shipped inverted glyph, node for node', () => {
    const still = renderToStaticMarkup(<BrandMarkFlow flowing={false} size={17} />);
    const shipped = renderToStaticMarkup(<BrandMark variant="mark" tone="inverted" size={17} />);
    expect(still).toBe(shipped);
  });

  it('runs no frame loop while not flowing', () => {
    render(<BrandMarkFlow flowing={false} size={17} />);
    expect(queue.size).toBe(0);
    expect(path().getAttribute('d')).toBe(WAVE_BAND_PATH);
  });
});

describe('flowing', () => {
  it('rewrites the path and fills it with the wave gradient, then eases back to the exact rest glyph', () => {
    const r = render(<BrandMarkFlow flowing size={17} />);
    expect(queue.size).toBe(1);
    frame();
    frame(200);
    expect(path().getAttribute('d')).not.toBe(WAVE_BAND_PATH);
    expect(path().getAttribute('fill')).toMatch(/^url\(#mark-flow-[A-Za-z0-9_-]+\)$/);
    const id = path().getAttribute('fill')!.slice(5, -1);
    expect(gradient()!.id).toBe(id);
    expect(gradient()!.getAttribute('gradientUnits')).toBe('userSpaceOnUse');
    const stops = [...gradient()!.querySelectorAll('stop')];
    expect(stops).toHaveLength(2);
    for (const stop of stops) expect(stop.style.stopColor).toMatch(/--el-mark-wave-/);
    // Still running.
    expect(queue.size).toBe(1);

    r.rerender(<BrandMarkFlow flowing={false} size={17} />);
    frame(FLOW_EASE_MS / 2);
    expect(path().getAttribute('d')).not.toBe(WAVE_BAND_PATH);
    frame(FLOW_EASE_MS);
    expect(path().getAttribute('d')).toBe(WAVE_BAND_PATH);
    expect(path().getAttribute('fill')).toBe('currentColor');
    expect(gradient()).toBeNull();
    // The loop has ended: nothing more is queued.
    expect(queue.size).toBe(0);
  });

  it('keeps the same path node from rest to flow and back', () => {
    const r = render(<BrandMarkFlow flowing={false} size={17} />);
    const node = path();
    r.rerender(<BrandMarkFlow flowing size={17} />);
    frame();
    frame();
    expect(path()).toBe(node);
    r.rerender(<BrandMarkFlow flowing={false} size={17} />);
    frame(FLOW_EASE_MS + 1);
    expect(path()).toBe(node);
  });

  it('stays decorative: aria-hidden, focusable false, and no role, name or live region', () => {
    render(<BrandMarkFlow flowing size={17} />);
    frame();
    frame();
    const svg = document.querySelector('svg')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('focusable')).toBe('false');
    for (const el of [svg, ...svg.querySelectorAll('*')]) {
      for (const a of ['role', 'aria-live', 'aria-label', 'tabindex']) {
        expect(el.hasAttribute(a)).toBe(false);
      }
    }
  });
});

describe('the loop stops when nobody can see it', () => {
  it('pauses while the tab is hidden and resumes when it is shown', () => {
    render(<BrandMarkFlow flowing size={17} />);
    frame();
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(queue.size).toBe(0);
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(queue.size).toBe(1);
  });

  it('pauses while the mark is off screen and resumes when it is back', () => {
    render(<BrandMarkFlow flowing size={17} />);
    frame();
    const [observer] = observers;
    expect(observer!.target).toBe(document.querySelector('svg'));
    const report = (isIntersecting: boolean) =>
      act(() => {
        observer!.cb([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver);
      });
    report(false);
    expect(queue.size).toBe(0);
    report(true);
    expect(queue.size).toBe(1);
  });
});

describe('reduced motion', () => {
  it('under prefers-reduced-motion: reduce no frame loop runs and the glyph stays still', () => {
    reduce = true;
    stubMedia();
    render(<BrandMarkFlow flowing size={17} />);
    expect(queue.size).toBe(0);
    expect(path().getAttribute('d')).toBe(WAVE_BAND_PATH);
    expect(path().getAttribute('fill')).toBe('currentColor');
    expect(gradient()).toBeNull();
  });

  it('with no matchMedia to ask, the motion stays off', () => {
    stubMedia(false);
    render(<BrandMarkFlow flowing size={17} />);
    expect(queue.size).toBe(0);
    expect(path().getAttribute('d')).toBe(WAVE_BAND_PATH);
  });
});
