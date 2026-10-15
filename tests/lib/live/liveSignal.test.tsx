// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  DEFAULT_LIVE_SOURCE,
  LiveSignalProvider,
  QUIET_LIVE_SOURCE,
  useLiveReconnecting,
  useLiveSignal,
  type LiveSignal,
  type LiveSignalListener,
  type LiveSignalSource,
  type LiveTopic,
} from '@/lib/live/liveSignal';
import { createLiveFlag } from '@/lib/live/liveFlag';
import { POLL_MS, planPollSource } from '@/lib/live/sources/planPollSource';
import {
  WORKBENCH_STREAM_PATH,
  createWorkbenchStreamSource,
} from '@/lib/live/sources/workbenchStreamSource';

// THE LIVE-SIGNAL SEAM (Story MOTIR-8539 · Subtask MOTIR-8572).
//
// The seam's whole value is that an applier can be driven by something other
// than the two shipped transports, so the first thing pinned is a FAKE source
// supplied through the provider. Then the discipline that makes it cheap: one
// subscription per topic however often the caller re-renders, and one
// connection per workbench source however many subscribers.

/** A source the test fires by hand, counting subscriptions per topic. */
function fakeSource() {
  const listeners = new Map<string, Set<LiveSignalListener>>();
  const subscribes: string[] = [];
  const unsubscribes: string[] = [];
  const reconnecting = createLiveFlag(false);
  const key = (t: LiveTopic) => (t.kind === 'plan' ? `plan:${t.planId}` : 'workbench');
  let seq = 0;
  const source: LiveSignalSource = {
    subscribe(topic, onSignal) {
      const k = key(topic);
      subscribes.push(k);
      const set = listeners.get(k) ?? new Set();
      set.add(onSignal);
      listeners.set(k, set);
      return () => {
        unsubscribes.push(k);
        set.delete(onSignal);
      };
    },
    reconnecting,
  };
  return {
    source,
    subscribes,
    unsubscribes,
    reconnecting,
    fire(topic: LiveTopic, extra: Partial<LiveSignal> = {}) {
      seq += 1;
      for (const listener of listeners.get(key(topic)) ?? []) {
        act(() => listener({ topic, seq, ...extra }));
      }
    },
  };
}

const WORKBENCH: LiveTopic = { kind: 'workbench' };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useLiveSignal', () => {
  it('delivers a signal from a FAKE source supplied through the provider', () => {
    const fake = fakeSource();
    const seen: LiveSignal[] = [];
    const wrapper = ({ children }: { children: ReactNode }) => (
      <LiveSignalProvider source={fake.source}>{children}</LiveSignalProvider>
    );
    renderHook(() => useLiveSignal(WORKBENCH, (s) => seen.push(s)), { wrapper });

    fake.fire(WORKBENCH, { moved: ['toDo'] });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ topic: WORKBENCH, seq: 1, moved: ['toDo'] });
  });

  it('delivers NOTHING for the workbench from the QUIET default (no provider)', () => {
    const subscribe = vi.spyOn(QUIET_LIVE_SOURCE, 'subscribe');
    const seen: LiveSignal[] = [];
    renderHook(() => useLiveSignal(WORKBENCH, (s) => seen.push(s)));
    expect(subscribe).toHaveBeenCalledTimes(1);
    // QUIET's subscribe keeps no listener, so nothing can ever arrive.
    expect(seen).toHaveLength(0);
    subscribe.mockRestore();
  });

  it('a re-render with a NEW callback does not re-subscribe, and the latest callback is the one called', () => {
    const fake = fakeSource();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <LiveSignalProvider source={fake.source}>{children}</LiveSignalProvider>
    );
    const calls: string[] = [];
    const { rerender } = renderHook(
      ({ label }: { label: string }) => useLiveSignal(WORKBENCH, () => calls.push(label)),
      { wrapper, initialProps: { label: 'first' } },
    );
    rerender({ label: 'second' });
    rerender({ label: 'third' });
    expect(fake.subscribes).toEqual(['workbench']);

    fake.fire(WORKBENCH);
    expect(calls).toEqual(['third']);
  });

  it('an equal topic OBJECT is the same subscription; a different topic re-subscribes', () => {
    const fake = fakeSource();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <LiveSignalProvider source={fake.source}>{children}</LiveSignalProvider>
    );
    const { rerender } = renderHook(
      ({ planId }: { planId: string }) => useLiveSignal({ kind: 'plan', planId }, () => {}),
      { wrapper, initialProps: { planId: 'p1' } },
    );
    rerender({ planId: 'p1' });
    expect(fake.subscribes).toEqual(['plan:p1']);
    rerender({ planId: 'p2' });
    expect(fake.subscribes).toEqual(['plan:p1', 'plan:p2']);
    expect(fake.unsubscribes).toEqual(['plan:p1']);
  });

  it('unmounting unsubscribes, and `enabled: false` never subscribes', () => {
    const fake = fakeSource();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <LiveSignalProvider source={fake.source}>{children}</LiveSignalProvider>
    );
    const { unmount, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useLiveSignal(WORKBENCH, () => {}, { enabled }),
      { wrapper, initialProps: { enabled: false } },
    );
    expect(fake.subscribes).toEqual([]);
    rerender({ enabled: true });
    expect(fake.subscribes).toEqual(['workbench']);
    unmount();
    expect(fake.unsubscribes).toEqual(['workbench']);
  });

  it('`useLiveReconnecting` follows the source flag', () => {
    const fake = fakeSource();
    function Chip() {
      return <span>{useLiveReconnecting() ? 'reconnecting' : 'live'}</span>;
    }
    const { container } = render(
      <LiveSignalProvider source={fake.source}>
        <Chip />
      </LiveSignalProvider>,
    );
    expect(container.textContent).toBe('live');
    act(() => fake.reconnecting.set(true));
    expect(container.textContent).toBe('reconnecting');
  });
});

describe('the plan poll source', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('ticks once per POLL_MS for a subscribed plan, and stops on unsubscribe', () => {
    const seen: LiveSignal[] = [];
    const off = planPollSource.subscribe({ kind: 'plan', planId: 'p1' }, (s) => seen.push(s));
    vi.advanceTimersByTime(POLL_MS * 3);
    expect(seen).toHaveLength(3);
    expect(seen.every((s) => !s.forced)).toBe(true);
    expect(seen.map((s) => s.seq)).toEqual([...seen.map((s) => s.seq)].sort((a, b) => a - b));
    off();
    vi.advanceTimersByTime(POLL_MS * 3);
    expect(seen).toHaveLength(3);
  });

  it('`trigger` sends a FORCED signal to that plan only, at once', () => {
    const one: LiveSignal[] = [];
    const two: LiveSignal[] = [];
    const offOne = planPollSource.subscribe({ kind: 'plan', planId: 'p1' }, (s) => one.push(s));
    const offTwo = planPollSource.subscribe({ kind: 'plan', planId: 'p2' }, (s) => two.push(s));
    planPollSource.trigger!({ kind: 'plan', planId: 'p1' });
    expect(one).toEqual([expect.objectContaining({ forced: true })]);
    expect(two).toEqual([]);
    offOne();
    offTwo();
  });

  it('serves the plan topic with NO provider — the default source routes plan to the cadence', () => {
    const seen: LiveSignal[] = [];
    const off = DEFAULT_LIVE_SOURCE.subscribe({ kind: 'plan', planId: 'p9' }, (s) => seen.push(s));
    vi.advanceTimersByTime(POLL_MS);
    expect(seen).toHaveLength(1);
    off();
  });
});

describe('the workbench stream source', () => {
  /** A stream whose frames the test writes. */
  function stubStream() {
    const calls: string[] = [];
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const encoder = new TextEncoder();
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(String(input));
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
          },
        });
        init?.signal?.addEventListener('abort', () => {
          try {
            controller?.error(new DOMException('aborted', 'AbortError'));
          } catch {
            // Already closed.
          }
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      }),
    );
    return {
      calls,
      async send(frame: { moved: string[]; cursor: string }) {
        controller?.enqueue(encoder.encode(`event: watermark\ndata: ${JSON.stringify(frame)}\n\n`));
        await new Promise((r) => setTimeout(r, 0));
      },
    };
  }

  it('opens ONE connection however many subscribers, and a frame naming nothing signals nothing', async () => {
    const stream = stubStream();
    const source = createWorkbenchStreamSource();
    const a: LiveSignal[] = [];
    const b: LiveSignal[] = [];
    const offA = source.subscribe(WORKBENCH, (s) => a.push(s));
    const offB = source.subscribe(WORKBENCH, (s) => b.push(s));
    await new Promise((r) => setTimeout(r, 0));
    expect(stream.calls.filter((u) => u.includes(WORKBENCH_STREAM_PATH))).toHaveLength(1);

    await stream.send({ moved: [], cursor: 'c0' });
    expect(a).toHaveLength(0);
    await stream.send({ moved: ['toDo', 'approvals'], cursor: 'c1' });
    expect(a).toEqual([expect.objectContaining({ seq: 1, moved: ['toDo', 'approvals'] })]);
    expect(b).toHaveLength(1);

    offA();
    offB();
    // The cursor outlives the connection: the next subscriber resumes from it.
    const offC = source.subscribe(WORKBENCH, () => {});
    await new Promise((r) => setTimeout(r, 0));
    expect(stream.calls.at(-1)).toBe(`${WORKBENCH_STREAM_PATH}?since=c1`);
    offC();
  });

  it('ignores a plan topic — it holds no connection for one', async () => {
    const stream = stubStream();
    const source = createWorkbenchStreamSource();
    const off = source.subscribe({ kind: 'plan', planId: 'p1' }, () => {});
    await new Promise((r) => setTimeout(r, 0));
    expect(stream.calls).toHaveLength(0);
    off();
  });
});
