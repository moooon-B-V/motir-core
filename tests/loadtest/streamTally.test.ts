import { describe, expect, it } from 'vitest';
import {
  createStreamTally,
  HELD_STATES,
  LOST,
  NEVER_OPENED,
  OPEN_AT_END,
  parseWatermarkFrame,
  RECONNECTED,
  tallyStream,
} from '@/loadtest/k6/lib/streamTally.js';
import { holdStream, isRefusal, streamUrl } from '@/loadtest/k6/lib/holdStream.js';

// Story MOTIR-8538 · MOTIR-8677 — a held Workbench stream ends the run in exactly
// one state, and the hold reconnects like EventSource. k6 is not run here; the
// transport is a fake with a virtual clock.

const OPEN = { kind: 'open_ok' } as const;
const FRAME = { kind: 'frame' } as const;
const DROP = { kind: 'dropped' } as const;
const failed = (streamed: boolean) => ({ kind: 'open_failed', streamed }) as const;

describe('tallyStream — one end state per held stream', () => {
  it('open at end: opened, frames, never dropped', () => {
    expect(tallyStream([OPEN, FRAME, FRAME])).toBe(OPEN_AT_END);
  });

  it('one drop then a reconnect that got its opening frame', () => {
    expect(tallyStream([OPEN, FRAME, DROP, OPEN, FRAME])).toBe(RECONNECTED);
  });

  it('several drops, every one followed by a successful reconnect', () => {
    expect(tallyStream([OPEN, DROP, failed(false), OPEN, DROP, OPEN, FRAME, DROP, OPEN])).toBe(
      RECONNECTED,
    );
  });

  it('a final failed reconnect is lost', () => {
    expect(tallyStream([OPEN, DROP, OPEN, DROP, failed(false)])).toBe(LOST);
  });

  it('a 200 event-stream that never sent its opening frame is lost', () => {
    expect(tallyStream([failed(true)])).toBe(LOST);
  });

  it('a JSON refusal before the stream opened is never opened', () => {
    expect(tallyStream([failed(false)])).toBe(NEVER_OPENED);
  });

  it('counts drops and frames only on an open connection', () => {
    const t = createStreamTally();
    for (const e of [FRAME, OPEN, FRAME, FRAME, DROP, DROP, FRAME, OPEN, FRAME]) t.apply(e);
    expect(t.drops).toBe(1);
    expect(t.frames).toBe(3);
    expect(t.opened).toBe(true);
  });

  it('ignores events after the hold ended', () => {
    const t = createStreamTally();
    t.apply(OPEN);
    t.apply({ kind: 'hold_ended' });
    t.apply(DROP);
    expect(t.endState()).toBe(OPEN_AT_END);
  });

  it('the three held states are the three counters', () => {
    expect([...HELD_STATES]).toEqual(['open_at_end', 'reconnected', 'lost']);
  });
});

describe('parseWatermarkFrame', () => {
  it('reads a watermark frame', () => {
    expect(
      parseWatermarkFrame({ name: 'watermark', data: '{"moved":["todo"],"cursor":"c1"}' }),
    ).toEqual({ moved: ['todo'], cursor: 'c1' });
  });

  it('ignores a heartbeat, an error frame and a body that does not parse', () => {
    expect(parseWatermarkFrame({ name: '', data: '' })).toBeNull();
    expect(parseWatermarkFrame({ name: 'error', data: '{"code":"INTERNAL_ERROR"}' })).toBeNull();
    expect(parseWatermarkFrame({ name: 'watermark', data: '{not json' })).toBeNull();
  });
});

// ── holdStream against a fake transport ─────────────────────────────────────

type Ev = { name: string; data: string };
type Conn = { status: number; contentType?: string; frames?: number[]; endAt?: number };

const frame = (cursor: string, moved: string[] = []): Ev => ({
  name: 'watermark',
  data: JSON.stringify({ moved, cursor }),
});

/**
 * A fake xk6-sse: each call to `openStream` takes the next scripted connection.
 * `frames` are the virtual-clock offsets of its frames; `endAt` is when the server
 * ends it (undefined = it is still open when the client's timeout fires).
 */
function fakeServer(conns: Conn[]) {
  let clock = 0;
  const urls: string[] = [];
  let n = 0;
  const openStream = (url: string, timeoutMs: number, onEvent: (e: Ev) => void) => {
    urls.push(url);
    const c = conns[Math.min(n, conns.length - 1)]!;
    n += 1;
    const start = clock;
    for (const at of c.frames ?? []) {
      if (c.endAt !== undefined && at > c.endAt) break;
      if (at > timeoutMs) break;
      clock = start + at;
      onEvent(frame(`c${n}-${at}`, at > 0 ? ['todo'] : []));
    }
    clock = start + Math.min(c.endAt ?? Infinity, timeoutMs + 5);
    return { status: c.status, contentType: c.contentType ?? 'text/event-stream; charset=utf-8' };
  };
  return {
    openStream,
    urls,
    now: () => clock,
    sleep: (ms: number) => {
      clock += ms;
    },
  };
}

describe('holdStream — holds and reconnects like EventSource', () => {
  it('holds one connection to the end of the hold', () => {
    const s = fakeServer([{ status: 200, frames: [0, 500] }]);
    const r = holdStream({ ...s, holdMs: 10_000, path: '/api/workbench/stream' });
    expect(r.state).toBe(OPEN_AT_END);
    expect(r.attempts).toBe(1);
    expect(r.frames).toBe(2);
  });

  it('a server restart mid-hold is reconnected, not lost, with ?since= the last cursor', () => {
    const s = fakeServer([
      { status: 200, frames: [0, 1000], endAt: 2000 }, // the server goes away
      { status: 0, endAt: 0 }, // still down after the 3 s back-off
      { status: 200, frames: [0] }, // back up
    ]);
    const attempts: Array<{ opened: boolean; reconnect: boolean; firstOpen: boolean }> = [];
    const r = holdStream({
      ...s,
      holdMs: 30_000,
      path: '/api/workbench/stream',
      onAttempt: (a: { opened: boolean; reconnect: boolean; firstOpen: boolean }) =>
        attempts.push(a),
    });
    expect(r.state).toBe(RECONNECTED);
    expect(r.drops).toBe(1);
    expect(s.urls[0]).toBe('/api/workbench/stream');
    expect(s.urls[1]).toBe('/api/workbench/stream?since=c1-1000');
    expect(attempts.map((a) => a.opened)).toEqual([true, false, true]);
    expect(attempts.filter((a) => a.firstOpen)).toHaveLength(1);
    expect(attempts.map((a) => a.reconnect)).toEqual([false, true, true]);
  });

  it('a server that stays down after a drop leaves the stream lost', () => {
    const s = fakeServer([
      { status: 200, frames: [0], endAt: 1000 },
      { status: 0, endAt: 0 },
    ]);
    const r = holdStream({ ...s, holdMs: 20_000, path: '/s' });
    expect(r.state).toBe(LOST);
  });

  it('a first-attempt refusal is not retried and never opens', () => {
    for (const status of [401, 403, 404, 307]) {
      const s = fakeServer([{ status, contentType: 'application/json', endAt: 0 }]);
      const r = holdStream({ ...s, holdMs: 20_000, path: '/s' });
      expect(r.state).toBe(NEVER_OPENED);
      expect(r.attempts).toBe(1);
    }
  });

  it('a first answer that is a page, not a stream, is a refusal', () => {
    const s = fakeServer([{ status: 200, contentType: 'text/html', endAt: 0 }]);
    expect(holdStream({ ...s, holdMs: 20_000, path: '/s' }).state).toBe(NEVER_OPENED);
  });

  it('a 200 stream that never sends its opening frame is retried, and lost if it never does', () => {
    const s = fakeServer([{ status: 200, endAt: 100 }]);
    const r = holdStream({ ...s, holdMs: 10_000, path: '/s' });
    expect(r.state).toBe(LOST);
    expect(r.attempts).toBeGreaterThan(1);
  });

  it('isRefusal: 4xx and 3xx refuse, 408/429/5xx/transport retry', () => {
    expect(isRefusal(401, 'application/json')).toBe(true);
    expect(isRefusal(307, null)).toBe(true);
    expect(isRefusal(429, 'application/json')).toBe(false);
    expect(isRefusal(503, 'text/plain')).toBe(false);
    expect(isRefusal(0, null)).toBe(false);
    expect(isRefusal(200, 'text/event-stream')).toBe(false);
  });

  it('streamUrl carries the cursor only once one is known', () => {
    expect(streamUrl('/s', null)).toBe('/s');
    expect(streamUrl('/s', 'a b')).toBe('/s?since=a%20b');
  });
});
