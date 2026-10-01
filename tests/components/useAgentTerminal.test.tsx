// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { RefObject } from 'react';
import {
  TERMINAL_PING_MS,
  parseSessionListings,
  terminalSessionKey,
  useAgentTerminal,
  type TerminalSink,
} from '@/app/(authed)/my-agents/_components/useAgentTerminal';

// THE TERMINAL'S SOCKET — the hook's own edges (Story MOTIR-6861 · MOTIR-6941;
// MOTIR-7062 — the lane measures it now), topping up `AgentPanel.test.tsx`, which
// drives the happy path and the close codes through the panel. The ticket route at
// `fetch`, the relay at `WebSocket`: every answer the ticket route can give, every
// frame the relay can send, and the rule that a superseded attempt — its fetch, its
// socket — goes INERT rather than moving the state of the one that replaced it.

class FakeSocket {
  static instances: FakeSocket[] = [];
  static throwOnConstruct = false;
  readyState = 0;
  binaryType = 'blob';
  sent: Array<string | Uint8Array> = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(public url: string) {
    if (FakeSocket.throwOnConstruct) throw new Error('blocked');
    FakeSocket.instances.push(this);
  }
  send(data: string | Uint8Array) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  accept() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(data: unknown) {
    this.onmessage?.({ data });
  }
  frame(obj: Record<string, unknown>) {
    this.message(JSON.stringify(obj));
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  get frames(): Array<Record<string, unknown>> {
    return this.sent
      .filter((s): s is string => typeof s === 'string')
      .map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}
const last = () => FakeSocket.instances[FakeSocket.instances.length - 1]!;

const GRANT = { url: 'wss://relay/t', ticket: 'tkt' };

/** One answer of the ticket route per attempt; an empty queue grants. */
let answers: Array<() => Promise<Response>> = [];
const answer = (status: number, body: unknown) => () =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));
const unparsable = (status: number) => () => Promise.resolve(new Response('not json', { status }));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeSink(): RefObject<TerminalSink | null> & { writes: number[][]; resets: number } {
  const ref = { writes: [] as number[][], resets: 0, current: null as TerminalSink | null };
  ref.current = {
    write: (b: Uint8Array) => ref.writes.push(Array.from(b)),
    reset: () => {
      ref.resets += 1;
    },
    size: () => ({ cols: 120, rows: 40 }),
  };
  return ref;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  FakeSocket.throwOnConstruct = false;
  answers = [];
  window.sessionStorage.clear();
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => (answers.shift() ?? answer(200, GRANT))()),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Let the ticket fetch and its JSON settle. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });

function terminal(sink: RefObject<TerminalSink | null> = makeSink(), enabled = true) {
  return renderHook(
    ({ on }: { on: boolean }) =>
      useAgentTerminal({ projectKey: 'PROD', agentId: 'a1', enabled: on, sink }),
    { initialProps: { on: enabled } },
  );
}

/** Accept the latest socket and attach it to a shell. */
function live(frame: Record<string, unknown> = { t: 'ready', session: 'sess-1' }) {
  const ws = last();
  act(() => ws.accept());
  act(() => ws.frame(frame));
  return ws;
}

describe('parseSessionListings', () => {
  it('keeps shells and tagged runs; drops anything malformed rather than echo it', () => {
    expect(parseSessionListings('nope')).toEqual([]);
    expect(
      parseSessionListings([
        null,
        7,
        { kind: 'shell' },
        { session: 's1', kind: 'shell' },
        { session: 'r1', kind: 'run', runId: 'run-1' },
        { session: 'r2', kind: 'run' },
        { session: 'x', kind: 'other' },
      ]),
    ).toEqual([
      { session: 's1', kind: 'shell' },
      { session: 'r1', kind: 'run', runId: 'run-1' },
    ]);
  });
});

describe('useAgentTerminal — the ticket route’s answers', () => {
  it('a disabled agent asks for nothing and reads idle', async () => {
    const { result } = terminal(makeSink(), false);
    await settle();
    expect(result.current.conn).toEqual({ kind: 'idle' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a 404 is the not-available face; not_running and no_terminal_server are their own', async () => {
    answers = [answer(404, {})];
    const gone = terminal();
    await settle();
    expect(gone.result.current.conn).toEqual({ kind: 'notAvailable' });
    gone.unmount();

    answers = [answer(409, { code: 'not_running' })];
    const asleep = terminal();
    await settle();
    expect(asleep.result.current.conn).toEqual({ kind: 'notRunning' });
    asleep.unmount();

    answers = [answer(409, { code: 'no_terminal_server' })];
    const none = terminal();
    await settle();
    expect(none.result.current.conn).toEqual({ kind: 'noTerminal' });
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('an unreachable route, an unparsable refusal, an unparsable grant, a grant without a ticket and a blocked socket each retry, backing off', async () => {
    answers = [
      () => Promise.reject(new Error('offline')),
      unparsable(500),
      unparsable(200),
      answer(200, { url: 'wss://relay/t' }),
    ];
    const { result } = terminal();
    await settle();
    // Never live yet, so the wait reads connecting — not reconnecting.
    expect(result.current.conn).toEqual({ kind: 'connecting' });
    expect(fetch).toHaveBeenCalledTimes(1);
    for (const [delay, calls] of [
      [1_000, 2],
      [2_000, 3],
      [4_000, 4],
    ] as const) {
      await act(async () => {
        vi.advanceTimersByTime(delay - 1);
      });
      expect(fetch).toHaveBeenCalledTimes(calls - 1);
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      await settle();
      expect(fetch).toHaveBeenCalledTimes(calls);
      expect(result.current.conn).toEqual({ kind: 'connecting' });
    }
    FakeSocket.throwOnConstruct = true;
    await act(async () => {
      vi.advanceTimersByTime(8_000);
    });
    await settle();
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(FakeSocket.instances).toHaveLength(0);
    expect(result.current.conn).toEqual({ kind: 'connecting' });

    FakeSocket.throwOnConstruct = false;
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    await settle();
    live();
    expect(result.current.conn).toEqual({ kind: 'live' });
  });

  it('a sink not yet mounted opens at 80×24', async () => {
    terminal({ current: null });
    await settle();
    act(() => last().accept());
    expect(last().frames).toEqual([
      { t: 'auth', ticket: 'tkt' },
      { t: 'open', cols: 80, rows: 24 },
    ]);
  });
});

describe('useAgentTerminal — a superseded attempt goes inert', () => {
  it('a ticket that answers after the agent stopped — granted, refused or failed — moves nothing', async () => {
    for (const settleIt of [
      (d: ReturnType<typeof deferred<Response>>) =>
        d.resolve(new Response(JSON.stringify(GRANT), { status: 200 })),
      (d: ReturnType<typeof deferred<Response>>) =>
        d.resolve(new Response(JSON.stringify({ code: 'not_running' }), { status: 409 })),
      (d: ReturnType<typeof deferred<Response>>) => d.reject(new Error('offline')),
    ]) {
      const d = deferred<Response>();
      answers = [() => d.promise];
      const { result, rerender, unmount } = terminal();
      await settle();
      rerender({ on: false });
      expect(result.current.conn).toEqual({ kind: 'idle' });
      settleIt(d);
      await settle();
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(result.current.conn).toEqual({ kind: 'idle' });
      expect(FakeSocket.instances).toHaveLength(0);
      expect(fetch).toHaveBeenCalledTimes(1);
      unmount();
      vi.mocked(fetch).mockClear();
    }
  });

  it('a body read that finishes after the agent stopped moves nothing either', async () => {
    for (const status of [200, 409]) {
      const body = deferred<unknown>();
      answers = [
        () => Promise.resolve({ ok: status < 400, status, json: () => body.promise } as Response),
      ];
      const { result, rerender, unmount } = terminal();
      await settle();
      rerender({ on: false });
      body.resolve(status === 200 ? GRANT : { code: 'not_running' });
      await settle();
      expect(result.current.conn).toEqual({ kind: 'idle' });
      expect(FakeSocket.instances).toHaveLength(0);
      unmount();
    }
  });

  it('the old socket’s open, frames and close are ignored once Reconnect has replaced it', async () => {
    const sink = makeSink();
    const { result } = terminal(sink);
    await settle();
    const old = last();
    act(() => result.current.reconnect());
    await settle();
    expect(FakeSocket.instances).toHaveLength(2);
    act(() => old.accept());
    act(() => old.frame({ t: 'ready', session: 'stale' }));
    act(() => old.message(new Uint8Array([1]).buffer));
    act(() => old.drop(4403));
    expect(old.sent).toEqual([]);
    expect(sink.writes).toEqual([]);
    expect(result.current.conn).toEqual({ kind: 'connecting' });
    expect(window.sessionStorage.getItem(terminalSessionKey('a1'))).toBeNull();
  });
});

describe('useAgentTerminal — the relay’s frames', () => {
  it('writes ArrayBuffers and typed-array views; drops anything else and every malformed control frame', async () => {
    const sink = makeSink();
    const { result } = terminal(sink);
    await settle();
    const ws = live();
    act(() => ws.message(new Uint8Array([104, 105]).buffer));
    act(() => ws.message(new Uint8Array([0, 33, 0]).subarray(1, 2)));
    act(() => ws.message(42));
    act(() => ws.message('not json'));
    act(() => ws.message('7'));
    act(() => ws.message('null'));
    act(() => ws.frame({ t: 'mystery' }));
    act(() => ws.frame({ t: 'error', code: 'something_else' }));
    expect(sink.writes).toEqual([[104, 105], [33]]);
    expect(result.current.conn).toEqual({ kind: 'live' });
  });

  it('a sign-in frame with an unknown state is ignored; one with no profile still lands', async () => {
    const { result } = terminal();
    await settle();
    const ws = live();
    act(() => ws.frame({ t: 'signin', profile: 'claude', state: 'maybe' }));
    expect(result.current.signIn).toBeNull();
    act(() => ws.frame({ t: 'signin', state: 'signed_out' }));
    expect(result.current.signIn).toEqual({ profile: null, state: 'signed_out' });
  });

  it('a `ready` with no session id keeps no reconnect token; a second `ready` restarts the heartbeat rather than doubling it', async () => {
    const { result } = terminal();
    await settle();
    const ws = live({ t: 'ready' });
    expect(result.current.conn).toEqual({ kind: 'live' });
    expect(window.sessionStorage.getItem(terminalSessionKey('a1'))).toBeNull();
    act(() => ws.frame({ t: 'sessions', sessions: [{ session: 'r1', kind: 'run', runId: 'x' }] }));
    expect(result.current.sessions).toHaveLength(1);
    // A re-attach starts with no listing: one from before may name an ended run.
    act(() => ws.frame({ t: 'ready', session: 'sess-2' }));
    expect(result.current.sessions).toEqual([]);
    act(() => vi.advanceTimersByTime(TERMINAL_PING_MS));
    expect(ws.frames.filter((f) => f['t'] === 'ping')).toHaveLength(1);
  });

  it('typing and resizes are held while not live, and the heartbeat says nothing into a closing socket', async () => {
    const { result } = terminal();
    await settle();
    const ws = last();
    act(() => ws.accept());
    act(() => result.current.sendInput('ls\r'));
    act(() => result.current.sendResize(100, 30));
    expect(ws.sent).toHaveLength(2); // auth + open only
    act(() => ws.frame({ t: 'ready', session: 'sess-1' }));
    ws.readyState = 2;
    act(() => vi.advanceTimersByTime(TERMINAL_PING_MS));
    expect(ws.frames.filter((f) => f['t'] === 'ping')).toHaveLength(0);
  });

  it('4409 from the relay is the cue that the machine is not running', async () => {
    const { result } = terminal();
    await settle();
    const ws = live();
    act(() => ws.drop(4409));
    expect(result.current.conn).toEqual({ kind: 'notRunning' });
  });

  it('blocked browser storage: the shell still works, it just won’t reattach on reload', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = terminal();
    await settle();
    const ws = live();
    expect(ws.frames[1]).toEqual({ t: 'open', cols: 120, rows: 40 });
    expect(result.current.conn).toEqual({ kind: 'live' });
  });
});
