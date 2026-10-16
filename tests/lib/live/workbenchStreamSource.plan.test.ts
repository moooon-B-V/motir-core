// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkbenchStreamSource,
  PLAN_BACKSTOP_MS,
  PLAN_WATCH_SETTLE_MS,
  WORKBENCH_STREAM_HIDDEN_GRACE_MS,
  WORKBENCH_STREAM_PATH,
  type WorkbenchStreamSource,
} from '@/lib/live/sources/workbenchStreamSource';
import { formatWatchParams, WORKBENCH_STREAM_MAX_WATCHED_PLANS } from '@/lib/workbench/planWatch';
import type { LiveSignal } from '@/lib/live/liveSignal';

// THE PLAN TOPIC ON THE ONE STREAM (Story MOTIR-8542 · Subtask MOTIR-8732).
//
// A generating plan used to hold a 2.5 s timer beside the stream. Now its reads
// follow `plan` frames on the tab's one connection, so the failures to guard are
// the silent ones: a second connection opened for a plan, a set change that opens
// before it closes, a backstop timer that outlives a park, a plan frame that
// leaks into a Workbench listener.

let visibility: DocumentVisibilityState = 'visible';

function setVisibility(next: DocumentVisibilityState): void {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

interface Connection {
  url: string;
  aborted: boolean;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
}

/** Every fetch gets its own body; `openAtFetch` records how many were still open. */
function streams() {
  const connections: Connection[] = [];
  const openAtFetch: number[] = [];
  const encoder = new TextEncoder();
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      openAtFetch.push(connections.filter((c) => !c.aborted).length);
      const connection: Connection = { url: String(input), aborted: false, controller: null };
      connections.push(connection);
      init?.signal?.addEventListener('abort', () => {
        connection.aborted = true;
        try {
          connection.controller?.error(new DOMException('aborted', 'AbortError'));
        } catch {
          // Already closed.
        }
      });
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          connection.controller = c;
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    }),
  );
  const write = async (text: string) => {
    connections.at(-1)!.controller!.enqueue(encoder.encode(text));
    await vi.advanceTimersByTimeAsync(0);
  };
  return {
    connections,
    openAtFetch,
    urls: () => connections.map((c) => c.url),
    open: () => connections.filter((c) => !c.aborted),
    raw: write,
    watermark: (cursor: string, moved: string[] = []) =>
      write(`event: watermark\ndata: ${JSON.stringify({ moved, cursor })}\n\n`),
    plan: (planId: string, reviewVersion: string) =>
      write(`event: plan\ndata: ${JSON.stringify({ planId, reviewVersion })}\n\n`),
    /**
     * Advance `ms` with the server's heartbeat comment every 20 s, so a visible
     * tab's watchdog sees a healthy connection and the time spent is the
     * backstop's alone.
     */
    async healthy(ms: number) {
      let left = ms;
      while (left > 0) {
        const step = Math.min(20_000, left);
        const live = connections.filter((c) => !c.aborted).at(-1);
        if (live) {
          live.controller!.enqueue(encoder.encode(': hb\n\n'));
        }
        await vi.advanceTimersByTimeAsync(step);
        left -= step;
      }
    },
  };
}

let source: WorkbenchStreamSource;

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
});

afterEach(() => {
  source.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function collect() {
  const seen: LiveSignal[] = [];
  return { seen, listener: (s: LiveSignal) => seen.push(s) };
}

const watch = (planId: string, version: string | null = null) =>
  formatWatchParams([{ planId, version }]);

describe('one connection for both topics', () => {
  it('carries the plan in the one URL beside the cursor, and a plan alone opens and closes it', async () => {
    const s = streams();
    source.subscribe({ kind: 'workbench' }, () => {});
    await vi.advanceTimersByTimeAsync(0);
    await s.watermark('w1.c');
    source.subscribe({ kind: 'plan', planId: 'p1' }, () => {});
    await vi.advanceTimersByTimeAsync(PLAN_WATCH_SETTLE_MS);

    expect(s.open()).toHaveLength(1);
    expect(s.open()[0]!.url).toBe(`${WORKBENCH_STREAM_PATH}?since=w1.c&${watch('p1')}`);
    expect(s.open()[0]!.url).toContain('watch=p1%3A');
  });

  it('opens for a plan with no Workbench subscriber, and closes when it leaves', async () => {
    const s = streams();
    const off = source.subscribe({ kind: 'plan', planId: 'p1' }, () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(s.urls()).toEqual([`${WORKBENCH_STREAM_PATH}?${watch('p1')}`]);

    off();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.open()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('plan frames', () => {
  it('signal only that plan, once, with a per-plan seq, and never a Workbench listener', async () => {
    const s = streams();
    const wb = collect();
    const p1 = collect();
    const p2 = collect();
    source.subscribe({ kind: 'workbench' }, wb.listener);
    source.subscribe({ kind: 'plan', planId: 'p1' }, p1.listener);
    source.subscribe({ kind: 'plan', planId: 'p2' }, p2.listener);
    await vi.advanceTimersByTimeAsync(PLAN_WATCH_SETTLE_MS);

    await s.plan('p1', 'rv1.a');
    await s.plan('p1', 'rv1.b');
    await s.plan('p2', 'rv1.z');
    await s.plan('unwatched', 'rv1.q');

    expect(wb.seen).toEqual([]);
    expect(p1.seen.map((x) => x.seq)).toEqual([1, 2]);
    expect(p1.seen.every((x) => x.topic.kind === 'plan' && x.topic.planId === 'p1')).toBe(true);
    expect(p2.seen).toHaveLength(1);
    expect(p1.seen[0]!.full).toBeUndefined();
  });

  it('presents the latest version on the next reopen', async () => {
    const s = streams();
    source.subscribe({ kind: 'plan', planId: 'p1' }, () => {});
    await vi.advanceTimersByTimeAsync(0);
    await s.watermark('w1.c');
    await s.plan('p1', 'rv1.latest');

    source.subscribe({ kind: 'plan', planId: 'p2' }, () => {});
    await vi.advanceTimersByTimeAsync(PLAN_WATCH_SETTLE_MS);

    expect(s.urls().at(-1)).toBe(
      `${WORKBENCH_STREAM_PATH}?since=w1.c&${formatWatchParams([
        { planId: 'p1', version: 'rv1.latest' },
        { planId: 'p2', version: null },
      ])}`,
    );
  });
});

describe('a change to the watched set', () => {
  it('closes before it opens, after the settle, with the held cursor, and is not a drop', async () => {
    const s = streams();
    const reconnectingSeen: boolean[] = [];
    source.reconnecting.subscribe(() => reconnectingSeen.push(source.reconnecting.get()));
    source.subscribe({ kind: 'workbench' }, () => {});
    await vi.advanceTimersByTimeAsync(0);
    await s.watermark('w1.held');

    source.subscribe({ kind: 'plan', planId: 'p1' }, () => {});
    await vi.advanceTimersByTimeAsync(PLAN_WATCH_SETTLE_MS - 1);
    expect(s.connections).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(s.connections).toHaveLength(2);
    expect(s.connections[0]!.aborted).toBe(true);
    expect(s.openAtFetch).toEqual([0, 0]);
    expect(s.urls()[1]).toContain('since=w1.held');
    expect(reconnectingSeen).not.toContain(true);
  });

  it('pays one reopen for two subscriptions in one tick, none for a second listener, one on leave', async () => {
    const s = streams();
    source.subscribe({ kind: 'workbench' }, () => {});
    await vi.advanceTimersByTimeAsync(0);

    source.subscribe({ kind: 'plan', planId: 'p1' }, () => {});
    const offP2 = source.subscribe({ kind: 'plan', planId: 'p2' }, () => {});
    await vi.advanceTimersByTimeAsync(PLAN_WATCH_SETTLE_MS);
    expect(s.connections).toHaveLength(2);

    const offSecond = source.subscribe({ kind: 'plan', planId: 'p1' }, () => {});
    await vi.advanceTimersByTimeAsync(PLAN_WATCH_SETTLE_MS * 4);
    expect(s.connections).toHaveLength(2);

    offSecond();
    await vi.advanceTimersByTimeAsync(PLAN_WATCH_SETTLE_MS * 4);
    expect(s.connections).toHaveLength(2);

    offP2();
    await vi.advanceTimersByTimeAsync(PLAN_WATCH_SETTLE_MS);
    expect(s.connections).toHaveLength(3);
    expect(s.urls()[2]).not.toContain('p2');
    expect(s.openAtFetch.every((n) => n === 0)).toBe(true);
    expect(source.reconnecting.get()).toBe(false);
  });

  it('only records a change while parked, and the show-time reopen carries it', async () => {
    const s = streams();
    source.subscribe({ kind: 'workbench' }, () => {});
    await vi.advanceTimersByTimeAsync(0);
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_HIDDEN_GRACE_MS);
    expect(s.open()).toHaveLength(0);

    source.subscribe({ kind: 'plan', planId: 'p1' }, () => {});
    await vi.advanceTimersByTimeAsync(PLAN_WATCH_SETTLE_MS * 4);
    expect(s.connections).toHaveLength(1);

    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(s.connections).toHaveLength(2);
    expect(s.urls()[1]).toContain(watch('p1'));
  });
});

describe('the backstop', () => {
  it('emits one full signal per watched plan per interval while the connection is up', async () => {
    const s = streams();
    const p1 = collect();
    const p2 = collect();
    source.subscribe({ kind: 'plan', planId: 'p1' }, p1.listener);
    source.subscribe({ kind: 'plan', planId: 'p2' }, p2.listener);
    await vi.advanceTimersByTimeAsync(PLAN_WATCH_SETTLE_MS);

    await s.healthy(5 * 60_000);
    // Five intervals of PLAN_BACKSTOP_MS each, give or take the settle offset.
    expect(p1.seen.filter((x) => x.full)).toHaveLength(Math.floor((5 * 60_000) / PLAN_BACKSTOP_MS));
    expect(p2.seen.filter((x) => x.full)).toHaveLength(Math.floor((5 * 60_000) / PLAN_BACKSTOP_MS));
  });

  it('runs no timer while parked, and restarts on show', async () => {
    const s = streams();
    const p1 = collect();
    source.subscribe({ kind: 'plan', planId: 'p1' }, p1.listener);
    await vi.advanceTimersByTimeAsync(0);

    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_HIDDEN_GRACE_MS);
    const atPark = p1.seen.length;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(p1.seen).toHaveLength(atPark);
    expect(vi.getTimerCount()).toBe(0);

    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    await s.healthy(PLAN_BACKSTOP_MS);
    expect(p1.seen.filter((x) => x.full).length).toBeGreaterThan(0);
  });

  it(`reaches a plan watched beyond the ${WORKBENCH_STREAM_MAX_WATCHED_PLANS}th, which the URL leaves out`, async () => {
    const s = streams();
    const extra = collect();
    for (let i = 0; i < WORKBENCH_STREAM_MAX_WATCHED_PLANS; i++) {
      source.subscribe({ kind: 'plan', planId: `p${i}` }, () => {});
    }
    source.subscribe({ kind: 'plan', planId: 'p-extra' }, extra.listener);
    await vi.advanceTimersByTimeAsync(PLAN_WATCH_SETTLE_MS);

    expect(s.open()).toHaveLength(1);
    expect(s.open()[0]!.url).not.toContain('p-extra');
    await s.healthy(PLAN_BACKSTOP_MS);
    expect(extra.seen.filter((x) => x.full)).toHaveLength(1);
  });
});

describe('trigger', () => {
  it('emits one forced signal per listener of that plan and nothing to others', async () => {
    streams();
    const a = collect();
    const b = collect();
    const other = collect();
    const wb = collect();
    source.subscribe({ kind: 'plan', planId: 'p1' }, a.listener);
    source.subscribe({ kind: 'plan', planId: 'p1' }, b.listener);
    source.subscribe({ kind: 'plan', planId: 'p2' }, other.listener);
    source.subscribe({ kind: 'workbench' }, wb.listener);

    source.trigger!({ kind: 'plan', planId: 'p1' });

    expect(a.seen).toEqual([expect.objectContaining({ forced: true })]);
    expect(b.seen).toEqual([expect.objectContaining({ forced: true })]);
    expect(other.seen).toEqual([]);
    expect(wb.seen).toEqual([]);
  });
});

describe('with no plan watched', () => {
  it('keeps the Workbench URL exactly as before and runs no backstop', async () => {
    const s = streams();
    source.subscribe({ kind: 'workbench' }, () => {});
    await vi.advanceTimersByTimeAsync(0);
    await s.watermark('w1.c');
    expect(s.urls()).toEqual([WORKBENCH_STREAM_PATH]);
    // The watchdog is the only timer a Workbench-only connection owns.
    expect(vi.getTimerCount()).toBe(1);
  });
});

// ── THE EDGE ARMS (Story MOTIR-8542 · MOTIR-8733) ──────────────────────────
// The story gate's per-file coverage floor named the arms no case above reached.

describe('the edge arms', () => {
  it('a malformed plan frame and a watermark frame with no `moved` list signal nobody', async () => {
    const s = streams();
    const wb = collect();
    const p1 = collect();
    source.subscribe({ kind: 'workbench' }, wb.listener);
    source.subscribe({ kind: 'plan', planId: 'p1' }, p1.listener);
    await vi.advanceTimersByTimeAsync(PLAN_WATCH_SETTLE_MS);

    await s.raw(`event: plan\ndata: ${JSON.stringify({ planId: 'p1', reviewVersion: 7 })}\n\n`);
    await s.raw(`event: watermark\ndata: ${JSON.stringify({ moved: 'toDo', cursor: 'w1.x' })}\n\n`);

    expect(p1.seen).toEqual([]);
    expect(wb.seen).toEqual([]);
  });

  it('an un-subscribe called twice removes once, for either topic', async () => {
    const s = streams();
    const offWb = source.subscribe({ kind: 'workbench' }, () => {});
    const offPlan = source.subscribe({ kind: 'plan', planId: 'p1' }, () => {});
    const keep = source.subscribe({ kind: 'plan', planId: 'p2' }, () => {});
    await vi.advanceTimersByTimeAsync(PLAN_WATCH_SETTLE_MS);
    offPlan();
    offPlan();
    offWb();
    offWb();
    await vi.advanceTimersByTimeAsync(PLAN_WATCH_SETTLE_MS);
    // p2 still holds the one connection.
    expect(s.open()).toHaveLength(1);
    keep();
  });

  it('a trigger for a plan nobody watches is a no-op', () => {
    streams();
    expect(() => source.trigger!({ kind: 'plan', planId: 'nobody' })).not.toThrow();
  });

  it('a set change undone inside the settle window reopens nothing', async () => {
    const s = streams();
    source.subscribe({ kind: 'workbench' }, () => {});
    await vi.advanceTimersByTimeAsync(0);
    const off = source.subscribe({ kind: 'plan', planId: 'p1' }, () => {});
    off();
    await vi.advanceTimersByTimeAsync(PLAN_WATCH_SETTLE_MS * 2);
    expect(s.connections).toHaveLength(1);
  });

  it('a first subscription in a HIDDEN tab arms the grace at once, and parks', async () => {
    const s = streams();
    visibility = 'hidden';
    source.subscribe({ kind: 'plan', planId: 'p1' }, () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(s.open()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_HIDDEN_GRACE_MS);
    expect(s.open()).toHaveLength(0);
  });

  it('a non-OK answer is a drop: it says reconnecting and retries', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        calls.push(String(input));
        return Promise.resolve(new Response('nope', { status: 503 }));
      }),
    );
    source.subscribe({ kind: 'plan', planId: 'p1' }, () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(source.reconnecting.get()).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});
