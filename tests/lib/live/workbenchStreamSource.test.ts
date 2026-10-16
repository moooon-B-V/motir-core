// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkbenchStreamSource,
  STREAM_STALE_MS,
  WORKBENCH_STREAM_HIDDEN_GRACE_MS,
  WORKBENCH_STREAM_PATH,
  type WorkbenchStreamSource,
} from '@/lib/live/sources/workbenchStreamSource';
import type { LiveSignal } from '@/lib/live/liveSignal';

// THE STREAM PARKS IN A HIDDEN TAB (Story MOTIR-8542 · Subtask MOTIR-8731).
//
// Every guarantee here is a TIMER INTERLEAVING: hide, the grace, a drop, the
// backoff, `offline` / `online` and the stale watchdog all act on one
// connection. The failures this card exists to prevent — a parked tab that still
// pings, a resume that shows Reconnecting… — only appear when a test drives the
// clock through them, so every case runs on fake timers with `Date` faked too
// (the watchdog measures silence with `Date.now()`).

let visibility: DocumentVisibilityState = 'visible';

function setVisibility(next: DocumentVisibilityState): void {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

/**
 * A stream under the test's control. Each fetch to the stream path opens a body
 * the test can write to; the request's abort signal errors that body, exactly as
 * a real `fetch` does.
 */
function controllableStream() {
  const calls: string[] = [];
  const aborted: boolean[] = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let failNext = 0;
  const encoder = new TextEncoder();
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    const index = aborted.push(false) - 1;
    init?.signal?.addEventListener('abort', () => {
      aborted[index] = true;
      try {
        controller?.error(new DOMException('aborted', 'AbortError'));
      } catch {
        // Already closed.
      }
    });
    if (failNext > 0) {
      failNext -= 1;
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    aborted,
    failNextFetch(times = 1) {
      failNext = times;
    },
    async send(frame: { moved: string[]; cursor: string }) {
      controller?.enqueue(encoder.encode(`event: watermark\ndata: ${JSON.stringify(frame)}\n\n`));
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

let source: WorkbenchStreamSource;
let received: LiveSignal[];
let reconnectingSeen: boolean[];

function subscribe(): () => void {
  return source.subscribe({ kind: 'workbench' }, (s) => received.push(s));
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
  source = createWorkbenchStreamSource();
  received = [];
  reconnectingSeen = [];
  source.reconnecting.subscribe(() => reconnectingSeen.push(source.reconnecting.get()));
});

afterEach(() => {
  source.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openWithCursor(stream: ReturnType<typeof controllableStream>, cursor: string) {
  const off = subscribe();
  await vi.advanceTimersByTimeAsync(0);
  await stream.send({ moved: [], cursor });
  return off;
}

describe('the hidden grace', () => {
  it('aborts the connection once the tab has been hidden for the grace period', async () => {
    const stream = controllableStream();
    await openWithCursor(stream, 'w1.a');

    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_HIDDEN_GRACE_MS - 1);
    expect(stream.aborted).toEqual([false]);

    await vi.advanceTimersByTimeAsync(1);
    expect(stream.aborted).toEqual([true]);
    expect(stream.calls).toHaveLength(1);
  });

  it('keeps the connection when the tab is shown again inside the grace', async () => {
    const stream = controllableStream();
    await openWithCursor(stream, 'w1.a');

    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_HIDDEN_GRACE_MS - 1_000);
    setVisibility('visible');
    // Past where the grace would have fired, and inside the stale window as
    // measured from the show — so only a park could have aborted it.
    await vi.advanceTimersByTimeAsync(STREAM_STALE_MS - 5_000);

    expect(stream.aborted).toEqual([false]);
    expect(stream.calls).toHaveLength(1);
  });
});

describe('parked means silent', () => {
  it('issues no fetch and owns no timer for ten minutes, offline and online included', async () => {
    const stream = controllableStream();
    await openWithCursor(stream, 'w1.a');

    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_HIDDEN_GRACE_MS);
    expect(vi.getTimerCount()).toBe(0);

    window.dispatchEvent(new Event('offline'));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(stream.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('parks a pump that dropped inside the grace, and cancels its backoff', async () => {
    const stream = controllableStream();
    await openWithCursor(stream, 'w1.a');
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(1_000);

    // The connection drops while hidden; reconnects fail until the grace runs out.
    stream.failNextFetch(100);
    window.dispatchEvent(new Event('offline'));
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_HIDDEN_GRACE_MS);

    const callsAtPark = stream.calls.length;
    expect(vi.getTimerCount()).toBe(0);
    expect(source.reconnecting.get()).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(stream.calls).toHaveLength(callsAtPark);
  });
});

describe('show resumes in place', () => {
  it('reopens once, at once, with the held cursor, and signals the catch-up once', async () => {
    const stream = controllableStream();
    await openWithCursor(stream, 'w1.held');
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_HIDDEN_GRACE_MS + 60_000);
    expect(stream.calls).toHaveLength(1);

    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(stream.calls).toHaveLength(2);
    expect(stream.calls[1]).toBe(`${WORKBENCH_STREAM_PATH}?since=${encodeURIComponent('w1.held')}`);

    await stream.send({ moved: ['toDo'], cursor: 'w1.after' });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ moved: ['toDo'] });
    // Show is not a fault: the flag never went up.
    expect(reconnectingSeen).not.toContain(true);
    expect(source.reconnecting.get()).toBe(false);
  });

  it('enters the drop path when the reopen fails, and clears it on a later success', async () => {
    const stream = controllableStream();
    await openWithCursor(stream, 'w1.held');
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_HIDDEN_GRACE_MS);

    stream.failNextFetch(1);
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(source.reconnecting.get()).toBe(true);
    expect(stream.calls).toHaveLength(2);

    // Backoff as today: the first failure waits 1s.
    await vi.advanceTimersByTimeAsync(999);
    expect(stream.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(stream.calls).toHaveLength(3);
    expect(stream.calls[2]).toContain('since=w1.held');
    expect(source.reconnecting.get()).toBe(false);
  });
});

describe('the watchdog in a hidden tab', () => {
  it('does not call a hidden silence a drop', async () => {
    const stream = controllableStream();
    await openWithCursor(stream, 'w1.a');
    setVisibility('hidden');
    // Shown again before the grace, so the connection is held — but the watchdog
    // has seen a silence longer than the stale window while hidden.
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_HIDDEN_GRACE_MS - 1);
    expect(stream.aborted).toEqual([false]);
    expect(source.reconnecting.get()).toBe(false);
  });

  it('does not trust the silence measured across a hidden spell on the first tick after show', async () => {
    const stream = controllableStream();
    await openWithCursor(stream, 'w1.a');
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_HIDDEN_GRACE_MS - 1);
    // A throttled tab: `Date.now()` moved on while its timers barely ran.
    vi.setSystemTime(Date.now() + STREAM_STALE_MS * 2);
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(stream.aborted).toEqual([false]);
    expect(reconnectingSeen).not.toContain(true);
  });

  it('still aborts and says reconnecting on the same silence while visible', async () => {
    const stream = controllableStream();
    await openWithCursor(stream, 'w1.a');
    await vi.advanceTimersByTimeAsync(STREAM_STALE_MS + 1_000);
    expect(stream.aborted[0]).toBe(true);
    expect(source.reconnecting.get()).toBe(true);
  });
});

describe('offline and online while visible', () => {
  it('says reconnecting, wakes on online with the held cursor, and signals once', async () => {
    const stream = controllableStream();
    await openWithCursor(stream, 'w1.held');

    stream.failNextFetch(10);
    window.dispatchEvent(new Event('offline'));
    await vi.advanceTimersByTimeAsync(0);
    expect(source.reconnecting.get()).toBe(true);
    // Let a couple of reconnects fail into a long backoff.
    await vi.advanceTimersByTimeAsync(3_000);

    stream.failNextFetch(0);
    const before = stream.calls.length;
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(stream.calls).toHaveLength(before + 1);
    expect(stream.calls.at(-1)).toContain('since=w1.held');

    await stream.send({ moved: ['inProgress', 'toDo'], cursor: 'w1.after' });
    expect(received).toHaveLength(1);
    expect(source.reconnecting.get()).toBe(false);
  });
});

describe('the last subscriber leaving', () => {
  async function leavesNothing(off: () => void, stream: ReturnType<typeof controllableStream>) {
    const removed = vi.spyOn(document, 'removeEventListener');
    off();
    await vi.advanceTimersByTimeAsync(0);
    expect(removed).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    const calls = stream.calls.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(stream.calls).toHaveLength(calls);
    // A later subscribe starts exactly one connection.
    subscribe();
    await vi.advanceTimersByTimeAsync(0);
    expect(stream.calls).toHaveLength(calls + 1);
  }

  it('while connected', async () => {
    const stream = controllableStream();
    const off = await openWithCursor(stream, 'w1.a');
    await leavesNothing(off, stream);
  });

  it('while parked', async () => {
    const stream = controllableStream();
    const off = await openWithCursor(stream, 'w1.a');
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_HIDDEN_GRACE_MS);
    setVisibility('visible');
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_HIDDEN_GRACE_MS);
    visibility = 'visible';
    await leavesNothing(off, stream);
  });

  it('while backing off', async () => {
    const stream = controllableStream();
    const off = await openWithCursor(stream, 'w1.a');
    stream.failNextFetch(10);
    window.dispatchEvent(new Event('offline'));
    await vi.advanceTimersByTimeAsync(0);
    expect(source.reconnecting.get()).toBe(true);
    stream.failNextFetch(0);
    await leavesNothing(off, stream);
  });

  it('holds no visibility listener with no subscriber, and one connection for two', async () => {
    const added = vi.spyOn(document, 'addEventListener');
    const stream = controllableStream();
    expect(added).not.toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    const offA = subscribe();
    const offB = subscribe();
    await vi.advanceTimersByTimeAsync(0);
    expect(stream.calls).toHaveLength(1);
    expect(added.mock.calls.filter(([type]) => type === 'visibilitychange')).toHaveLength(1);
    offA();
    offB();
  });
});
