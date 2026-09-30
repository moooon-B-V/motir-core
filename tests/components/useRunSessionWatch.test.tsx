// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { RefObject } from 'react';
import { useRunSessionWatch } from '@/app/(authed)/my-agents/_components/useRunSessionWatch';
import {
  TERMINAL_PING_MS,
  TERMINAL_RECONNECT_WINDOW_MS,
  type TerminalSink,
} from '@/app/(authed)/my-agents/_components/useAgentTerminal';

// WATCHING THE RUN'S SESSION — the hook's own edges (Story MOTIR-6864 · MOTIR-7030,
// topping up MOTIR-7029's `AgentPanelRun.test.tsx`, which drives the happy path
// through the panel). The ticket route at `fetch`, the relay at `WebSocket`; every
// way the watch can fail to open, or close, is driven here.

class FakeSocket {
  static instances: FakeSocket[] = [];
  static throwOnConstruct = false;
  readyState = 0;
  binaryType = 'blob';
  sent: string[] = [];
  closeThrows = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(public url: string) {
    if (FakeSocket.throwOnConstruct) throw new Error('blocked');
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    if (this.closeThrows) throw new Error('already closing');
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
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}
const last = () => FakeSocket.instances[FakeSocket.instances.length - 1]!;

type Answer = 'ok' | 'refused' | 'throws' | 'no-grant' | 'bad-json';
let answers: Answer[] = [];
let fetches = 0;

function grant(answer: Answer): Promise<Response> {
  fetches += 1;
  switch (answer) {
    case 'throws':
      return Promise.reject(new Error('offline'));
    case 'refused':
      return Promise.resolve(new Response('{}', { status: 409 }));
    case 'no-grant':
      return Promise.resolve(new Response(JSON.stringify({ url: 'wss://relay' }), { status: 200 }));
    case 'bad-json':
      return Promise.resolve(new Response('not json', { status: 200 }));
    default:
      return Promise.resolve(
        new Response(JSON.stringify({ url: 'wss://relay/t', ticket: 'tkt' }), { status: 200 }),
      );
  }
}

function makeSink(): RefObject<TerminalSink | null> & {
  writes: Uint8Array[];
  resets: number;
} {
  const writes: Uint8Array[] = [];
  const ref = {
    writes,
    resets: 0,
    current: null as TerminalSink | null,
  };
  ref.current = {
    write: (b: Uint8Array) => writes.push(b),
    reset: () => {
      ref.resets += 1;
    },
    size: () => ({ cols: 120, rows: 40 }),
  } as unknown as TerminalSink;
  return ref;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  FakeSocket.throwOnConstruct = false;
  answers = [];
  fetches = 0;
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => grant(answers.shift() ?? 'ok')),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Let the ticket fetch and its JSON settle. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });

function watch(session: string | null, sink = makeSink()) {
  return renderHook(
    ({ s }: { s: string | null }) =>
      useRunSessionWatch({ projectKey: 'PROD', agentId: 'a 1', session: s, sink }),
    { initialProps: { s: session } },
  );
}

describe('useRunSessionWatch', () => {
  it('opens the run session on a second socket, relays its bytes, pings, and ends on exit', async () => {
    const sink = makeSink();
    const { result } = watch('run-sess', sink);
    expect(result.current.conn).toEqual({ kind: 'connecting' });
    await settle();
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(
      '/api/projects/PROD/instances/a%201/terminal-ticket',
    );
    const socket = last();
    act(() => socket.accept());
    expect(socket.frames).toEqual([
      { t: 'auth', ticket: 'tkt' },
      { t: 'open', cols: 120, rows: 40, session: 'run-sess' },
    ]);
    // Resize is held until the watch is live.
    act(() => result.current.sendResize(100, 30));
    expect(socket.frames).toHaveLength(2);

    act(() => socket.frame({ t: 'ready' }));
    expect(result.current.conn).toEqual({ kind: 'live' });
    expect(sink.resets).toBe(1);
    act(() => socket.message(new Uint8Array([104, 105])));
    act(() => socket.message(new Uint8Array([33]).buffer));
    act(() => socket.message(42));
    expect(sink.writes.map((b) => Array.from(b))).toEqual([[104, 105], [33]]);
    act(() => socket.message('not json'));
    act(() => socket.frame({ t: 'sessions', sessions: [] }));
    act(() => socket.frame({ t: 'error', code: 'something_else' }));
    expect(result.current.conn).toEqual({ kind: 'live' });

    act(() => result.current.sendResize(100, 30));
    expect(socket.frames.at(-1)).toEqual({ t: 'resize', cols: 100, rows: 30 });
    act(() => vi.advanceTimersByTime(TERMINAL_PING_MS));
    expect(socket.frames.at(-1)).toMatchObject({ t: 'ping' });
    // A second `ready` (a re-open) restarts the heartbeat rather than doubling it.
    act(() => socket.frame({ t: 'ready' }));
    act(() => vi.advanceTimersByTime(TERMINAL_PING_MS));
    expect(socket.frames.filter((f) => f['t'] === 'ping')).toHaveLength(2);

    act(() => socket.frame({ t: 'exit' }));
    expect(result.current.conn).toEqual({ kind: 'ended' });
    // A close after the end is settled: nothing reopens.
    act(() => socket.drop(1006));
    expect(result.current.conn).toEqual({ kind: 'ended' });
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('`unknown_session` ends the watch; `taken_over` hands it to the other tab, and retake takes it back', async () => {
    const { result } = watch('run-sess');
    await settle();
    act(() => last().accept());
    act(() => last().frame({ t: 'error', code: 'unknown_session' }));
    expect(result.current.conn).toEqual({ kind: 'ended' });

    act(() => result.current.retake());
    await settle();
    act(() => last().accept());
    act(() => last().frame({ t: 'error', code: 'taken_over' }));
    expect(result.current.conn).toEqual({ kind: 'takenOver' });
    act(() => result.current.retake());
    expect(result.current.conn).toEqual({ kind: 'connecting' });
    await settle();
    expect(FakeSocket.instances).toHaveLength(3);
  });

  it('a refused ticket stops the watch; a sink not mounted opens at 80×24', async () => {
    answers = ['refused'];
    const refused = watch('run-sess');
    await settle();
    expect(refused.result.current.conn).toEqual({ kind: 'lost' });
    expect(FakeSocket.instances).toHaveLength(0);
    refused.unmount();

    const empty = { current: null } as RefObject<TerminalSink | null>;
    const { result } = watch('run-sess', empty as never);
    await settle();
    act(() => last().accept());
    expect(last().frames[1]).toMatchObject({ cols: 80, rows: 24 });
    expect(result.current.conn).toEqual({ kind: 'connecting' });
  });

  it('an unreachable ticket route, a grant with no ticket, bad JSON and a blocked socket each retry, backing off', async () => {
    answers = ['throws', 'no-grant', 'bad-json'];
    const { result } = watch('run-sess');
    await settle();
    expect(result.current.conn).toEqual({ kind: 'connecting' });
    expect(fetches).toBe(1);
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await settle();
    expect(fetches).toBe(2);
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    await settle();
    expect(fetches).toBe(3);
    FakeSocket.throwOnConstruct = true;
    await act(async () => {
      vi.advanceTimersByTime(4_000);
    });
    await settle();
    expect(fetches).toBe(4);
    expect(FakeSocket.instances).toHaveLength(0);
    expect(result.current.conn).toEqual({ kind: 'connecting' });

    // Past the reconnect window, the next failure gives up.
    FakeSocket.throwOnConstruct = false;
    answers = ['throws'];
    await act(async () => {
      vi.advanceTimersByTime(TERMINAL_RECONNECT_WINDOW_MS);
    });
    await settle();
    expect(result.current.conn).toEqual({ kind: 'lost' });
  });

  it('a stale ticket (4401) is re-minted once, a second 4401 or a refusal code loses the watch, any other drop retries', async () => {
    const { result } = watch('run-sess');
    await settle();
    act(() => last().accept());
    act(() => last().drop(4401));
    await settle();
    expect(FakeSocket.instances).toHaveLength(2);
    act(() => last().accept());
    act(() => last().drop(4401));
    expect(result.current.conn).toEqual({ kind: 'lost' });

    act(() => result.current.retake());
    await settle();
    act(() => last().accept());
    act(() => last().drop(4409));
    expect(result.current.conn).toEqual({ kind: 'lost' });

    act(() => result.current.retake());
    await settle();
    act(() => last().accept());
    act(() => last().frame({ t: 'ready' }));
    act(() => last().drop(1006));
    expect(result.current.conn).toEqual({ kind: 'connecting' });
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await settle();
    expect(FakeSocket.instances).toHaveLength(5);
  });

  it('a session going away mid-fetch discards the late answer; no session watches nothing', async () => {
    const { result, rerender } = watch('run-sess');
    // The fetch is in flight; the session goes before it answers.
    rerender({ s: null });
    await settle();
    expect(result.current.conn).toEqual({ kind: 'idle' });
    expect(FakeSocket.instances).toHaveLength(0);
    act(() => result.current.retake());
    expect(result.current.conn).toEqual({ kind: 'idle' });

    // A fetch that fails after the session changed schedules nothing.
    answers = ['throws'];
    rerender({ s: 'run-2' });
    rerender({ s: null });
    await settle();
    expect(result.current.conn).toEqual({ kind: 'idle' });
  });

  it('a superseded socket’s late events are ignored, and a socket that throws on close is still torn down', async () => {
    const { result, rerender } = watch('run-sess');
    await settle();
    const first = last();
    first.readyState = 1;
    first.closeThrows = true;
    rerender({ s: 'run-2' });
    await settle();
    // The old socket's events land after it was replaced.
    act(() => first.onopen?.());
    act(() => first.frame({ t: 'ready' }));
    act(() => first.drop(1006));
    expect(first.sent).toEqual([]);
    expect(result.current.conn).toEqual({ kind: 'connecting' });
    expect(last()).not.toBe(first);
  });

  it('pings report the tab as inactive while it is hidden', async () => {
    const { result } = watch('run-sess');
    await settle();
    act(() => last().accept());
    act(() => last().frame({ t: 'ready' }));
    expect(result.current.conn).toEqual({ kind: 'live' });
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => vi.advanceTimersByTime(TERMINAL_PING_MS));
    expect(last().frames.at(-1)).toEqual({ t: 'ping', active: false });
    visibility.mockRestore();
  });
});
