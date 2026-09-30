import { randomUUID } from 'node:crypto';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { db } from '@/lib/db';
import { TERMINAL_CLOSE } from '@/lib/agentTerminal/protocol';
import { ActivityThrottle } from '@/lib/agentTerminal/relay/activityThrottle';
import {
  dropConsoleBreadcrumbs,
  relaySentryInitOptions,
  scrubbedError,
} from '@/lib/agentTerminal/relay/monitoring';
import {
  createTerminalRelay,
  type TerminalRelay,
  type TerminalRelayDeps,
} from '@/lib/agentTerminal/relay/terminalRelay';
import {
  agentInstanceActivityService,
  agentInstanceClock,
} from '@/lib/services/agentInstanceActivityService';
import type { AgentTerminalAuthorization } from '@/lib/services/agentTerminalRelayService';

// THE AGENT-TERMINAL STORY GATE'S EDGES (Story MOTIR-6861 · MOTIR-6942).
//
// `agentTerminalStoryGate.test.ts` drives the assembled path against the real
// database and the real terminal server. What it cannot reach on purpose are the
// relay's DEFENSIVE arms — a peer that stops answering pings, a browser that
// floods frames while the machine is being dialled, a record that fails to
// write, a malformed upgrade — because a real, healthy peer never produces them.
// They are driven here with the relay's own injected seams (its deps are its
// contract: `scripts/relay.ts` wires the real services into exactly these) and a
// local WebSocket standing in for the machine. Each asserts the arm's observable
// outcome — the close code, what was reported, what was recorded — not merely
// that a line ran.

const ORIGIN = 'https://motir.test';

afterAll(async () => {
  await db.$disconnect();
});

// ── A stand-in machine and a relay over stubbed deps ────────────────────────

interface Machine {
  url: string;
  sockets: WebSocket[];
  close(): Promise<void>;
}

async function machine(opts: { autoPong?: boolean; onOpen?: (ws: WebSocket) => void } = {}) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', autoPong: opts.autoPong ?? true });
  await new Promise<void>((ok) => wss.once('listening', () => ok()));
  const m: Machine = {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/v1/terminal`,
    sockets: [],
    async close() {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((ok) => wss.close(() => ok()));
    },
  };
  wss.on('connection', (ws) => {
    m.sockets.push(ws);
    opts.onOpen?.(ws);
  });
  return m;
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

interface Harness {
  relay: TerminalRelay;
  url: string;
  port: number;
  logs: string[];
  reported: Error[];
  opened: string[];
  closed: Array<{ closeCode: number; closeReason: string }>;
}

function target(url: string): AgentTerminalAuthorization {
  return {
    ok: true,
    target: {
      instanceId: 'inst-1',
      userId: 'user-1',
      workspaceId: 'ws-1',
      dial: { url, headers: {} },
    },
  };
}

async function harness(overrides: Partial<TerminalRelayDeps> = {}): Promise<Harness> {
  const h = {
    logs: [] as string[],
    reported: [] as Error[],
    opened: [] as string[],
    closed: [] as Array<{ closeCode: number; closeReason: string }>,
  };
  const relay = createTerminalRelay({
    allowedOrigin: ORIGIN,
    authorize: async () => ({ ok: false, closeCode: TERMINAL_CLOSE.badTicket }),
    openConnection: async (input) => {
      h.opened.push(input.instanceId);
      return 'row-1';
    },
    closeConnection: async (input) => {
      h.closed.push({ closeCode: input.closeCode, closeReason: input.closeReason });
    },
    touchActivity: async () => {},
    heartbeat: async () => {},
    log: (line) => h.logs.push(line),
    reportError: (err) => h.reported.push(err),
    now: () => Date.now(),
    authTimeoutMs: 2_000,
    pingIntervalMs: 60_000,
    dialTimeoutMs: 2_000,
    ...overrides,
  });
  await new Promise<void>((ok) => relay.server.listen(0, '127.0.0.1', ok));
  const port = (relay.server.address() as AddressInfo).port;
  cleanup.push(() => relay.close());
  return { relay, port, url: `ws://127.0.0.1:${port}/v1/terminal`, ...h };
}

function browser(url: string, opts: { origin?: string; autoPong?: boolean } = {}) {
  const ws = new WebSocket(url, { origin: opts.origin ?? ORIGIN, autoPong: opts.autoPong ?? true });
  const closed = new Promise<number>((ok) => ws.on('close', (code) => ok(code)));
  const opened = new Promise<void>((ok, fail) => {
    ws.once('open', () => ok());
    ws.once('error', fail);
  });
  ws.on('error', () => {});
  return { ws, closed, opened };
}

async function until(done: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};

// ── The relay's refusals of a malformed peer ────────────────────────────────

describe('the relay refuses what a browser should never send', () => {
  it('a first frame that is too large to parse, not an object, or followed by more frames: 4401, and nothing after the refusal is read', async () => {
    const h = await harness();
    const big = browser(h.url);
    await big.opened;
    big.ws.send(JSON.stringify({ t: 'auth', ticket: 'x'.repeat(5_000) }));
    expect(await big.closed).toBe(TERMINAL_CLOSE.badTicket);

    const array = browser(h.url);
    await array.opened;
    array.ws.send('["auth"]');
    array.ws.send('{"t":"auth","ticket":"late"}'); // arrives after the refusal: ignored
    expect(await array.closed).toBe(TERMINAL_CLOSE.badTicket);
    expect(h.logs.filter((l) => l.includes('first frame is not auth'))).toHaveLength(2);
  });

  it('an Origin that is not a URL is a foreign origin (4403)', async () => {
    const h = await harness();
    const b = browser(h.url, { origin: 'not a url' });
    expect(await b.closed).toBe(TERMINAL_CLOSE.notOwner);
  });

  it('an upgrade whose target is not a URL at all is a 404, with no socket', async () => {
    const h = await harness();
    const answer = await new Promise<string>((ok) => {
      const socket = net.connect(h.port, '127.0.0.1', () => {
        socket.write(
          'GET http://[bad HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
        );
      });
      let text = '';
      socket.on('data', (d) => (text += d.toString('utf8')));
      socket.on('close', () => ok(text));
    });
    expect(answer).toMatch(/^HTTP\/1\.1 (404|400)/);
  });

  it('a frame over the size limit is a socket error, reported scrubbed', async () => {
    const m = await machine();
    cleanup.push(() => m.close());
    const h = await harness({ authorize: async () => target(m.url) });
    const b = browser(h.url);
    await b.opened;
    b.ws.send(JSON.stringify({ t: 'auth', ticket: 't' }));
    await until(() => m.sockets.length === 1);
    b.ws.send(Buffer.alloc(4 * 1024 * 1024 + 1), { binary: true });
    await b.closed;
    await until(() => h.reported.length > 0);
    expect(h.reported[0]!.message).toMatch(
      /^relay: browser socket error \(RangeError( [A-Z0-9_]+)?\)$/,
    );
  });

  it('runs on the decision’s own numbers when the process passes none', async () => {
    const relay = createTerminalRelay({
      allowedOrigin: ORIGIN,
      authorize: async () => ({ ok: false, closeCode: TERMINAL_CLOSE.badTicket }),
      openConnection: async () => 'row',
      closeConnection: async () => {},
      touchActivity: async () => {},
      heartbeat: async () => {},
      log: () => {},
      reportError: () => {},
      now: () => Date.now(),
    });
    await new Promise<void>((ok) => relay.server.listen(0, '127.0.0.1', ok));
    const port = (relay.server.address() as AddressInfo).port;
    const res = await new Promise<number>((ok) =>
      http.get(`http://127.0.0.1:${port}/healthz`, (r) => ok(r.statusCode ?? 0)),
    );
    expect(res).toBe(200);
    expect(relay.liveConnections).toBe(0);
    await relay.close();
  });
});

// ── While the ticket is being redeemed and the machine dialled ──────────────

describe('while the ticket is redeemed and the machine dialled', () => {
  it('a browser that leaves while its ticket is redeemed gets nothing, and a failing redeem after that is only reported', async () => {
    const gate = deferred<AgentTerminalAuthorization>();
    const h = await harness({ authorize: () => gate.promise });
    const b = browser(h.url);
    await b.opened;
    b.ws.send(JSON.stringify({ t: 'auth', ticket: 't' }));
    b.ws.close(1000);
    await b.closed;
    await until(() => h.logs.some((l) => l.includes('left before it opened')));
    gate.reject(new Error('redeem failed carrying the ticket t'));
    await until(() => h.reported.length === 1);
    expect(h.reported[0]!.message).toBe('relay: authorize failed (Error)');
    expect(h.opened).toEqual([]);
  });

  it('a browser that leaves before a SUCCESSFUL redeem opens nothing either', async () => {
    const gate = deferred<AgentTerminalAuthorization>();
    const h = await harness({ authorize: () => gate.promise });
    const b = browser(h.url);
    await b.opened;
    b.ws.send(JSON.stringify({ t: 'auth', ticket: 't' }));
    b.ws.close(1000);
    await until(() => h.logs.some((l) => l.includes('left before it opened')));
    gate.resolve(target('ws://127.0.0.1:1/v1/terminal'));
    await new Promise((r) => setTimeout(r, 50));
    expect(h.opened).toEqual([]);
  });

  it('a browser flooding frames before the machine answers is closed 1008 as a protocol error', async () => {
    const gate = deferred<AgentTerminalAuthorization>();
    const h = await harness({ authorize: () => gate.promise });
    const b = browser(h.url);
    await b.opened;
    b.ws.send(JSON.stringify({ t: 'auth', ticket: 't' }));
    for (let i = 0; i < 257; i += 1) b.ws.send(Buffer.from([i % 256]), { binary: true });
    expect(await b.closed).toBe(1008);
    gate.resolve({ ok: false, closeCode: TERMINAL_CLOSE.badTicket });
  });

  it('a connection whose open record fails still works, closes, and records nothing', async () => {
    const m = await machine({ onOpen: (ws) => ws.send(Buffer.from('hi'), { binary: true }) });
    cleanup.push(() => m.close());
    const h = await harness({
      authorize: async () => target(m.url),
      openConnection: async () => {
        throw new Error('db down');
      },
    });
    const b = browser(h.url);
    const got: Buffer[] = [];
    b.ws.on('message', (d) => got.push(Buffer.from(d as Buffer)));
    await b.opened;
    b.ws.send(JSON.stringify({ t: 'auth', ticket: 't' }));
    await until(() => got.length === 1);
    b.ws.close(1000);
    await until(() => h.logs.some((l) => l.includes('closed instance=inst-1')));
    await new Promise((r) => setTimeout(r, 50));
    expect(h.reported.map((e) => e.message)).toEqual(['relay: recording an open failed (Error)']);
    expect(h.closed).toEqual([]);
  });

  it('a close record that fails is reported, scrubbed', async () => {
    const m = await machine();
    cleanup.push(() => m.close());
    const h = await harness({
      authorize: async () => target(m.url),
      closeConnection: async () => {
        throw Object.assign(new Error('P2028 carrying nothing useful'), { code: 'P2028' });
      },
    });
    const b = browser(h.url);
    await b.opened;
    b.ws.send(JSON.stringify({ t: 'auth', ticket: 't' }));
    await until(() => m.sockets.length === 1);
    b.ws.close(1000);
    await until(() => h.reported.length === 1);
    expect(h.reported[0]!.message).toBe('relay: recording a close failed (Error P2028)');
  });
});

// ── Liveness ────────────────────────────────────────────────────────────────

describe('liveness (Q6’s protocol pings)', () => {
  it('a browser that never answers a ping is dropped 1001 — even before it authenticates', async () => {
    const h = await harness({ pingIntervalMs: 60, authTimeoutMs: 5_000 });
    const b = browser(h.url, { autoPong: false });
    await b.opened;
    expect(await b.closed).toBe(1001);
    expect(h.closed).toEqual([]); // no target, no row
  });

  it('a machine that never answers a ping closes the terminal 4502 ping_timeout', async () => {
    const m = await machine({ autoPong: false });
    cleanup.push(() => m.close());
    const h = await harness({ authorize: async () => target(m.url), pingIntervalMs: 80 });
    const b = browser(h.url);
    await b.opened;
    b.ws.send(JSON.stringify({ t: 'auth', ticket: 't' }));
    expect(await b.closed).toBe(TERMINAL_CLOSE.unreachable);
    await until(() => h.closed.length === 1);
    expect(h.closed[0]).toEqual({
      closeCode: TERMINAL_CLOSE.unreachable,
      closeReason: 'ping_timeout',
    });
  });

  it('a machine that closes with no status is a clean end (1000, terminal_closed)', async () => {
    const m = await machine({ onOpen: (ws) => setTimeout(() => ws.close(), 20) });
    cleanup.push(() => m.close());
    const h = await harness({ authorize: async () => target(m.url) });
    const b = browser(h.url);
    await b.opened;
    b.ws.send(JSON.stringify({ t: 'auth', ticket: 't' }));
    expect(await b.closed).toBe(1000);
    await until(() => h.closed.length === 1);
    expect(h.closed[0]).toEqual({ closeCode: 1000, closeReason: 'terminal_closed' });
  });
});

// ── The small modules ───────────────────────────────────────────────────────

describe('the relay’s small modules', () => {
  it('the throttle lets one bump a minute through per instance, and forgets instances whose window passed', () => {
    let now = 0;
    const throttle = new ActivityThrottle(() => now);
    expect(throttle.take('a')).toBe(true);
    expect(throttle.take('a')).toBe(false);
    expect(throttle.take('b')).toBe(true);
    expect(throttle.size).toBe(2);
    now = 59_999;
    expect(throttle.take('a')).toBe(false);
    now = 60_000;
    throttle.prune();
    expect(throttle.size).toBe(0);
    expect(throttle.take('a')).toBe(true);
    // Past a thousand remembered instances it prunes itself on the way.
    for (let i = 0; i < 1_001; i += 1) throttle.take(`i-${i}`);
    now = 200_000;
    expect(throttle.take('fresh')).toBe(true);
    expect(throttle.size).toBe(1);
  });

  it('monitoring: off without a DSN; with one, the server options plus a breadcrumb filter that drops console', () => {
    vi.stubEnv('SENTRY_DSN', '');
    expect(relaySentryInitOptions()).toBeNull();
    vi.stubEnv('SENTRY_DSN', 'https://key@sentry.example/1');
    const options = relaySentryInitOptions()!;
    expect(options).toMatchObject({ dsn: 'https://key@sentry.example/1', sendDefaultPii: false });
    expect(options.beforeBreadcrumb).toBe(dropConsoleBreadcrumbs);
    expect(dropConsoleBreadcrumbs({ category: 'console', message: 'MARKER' })).toBeNull();
    const http = { category: 'http', message: 'GET /healthz' };
    expect(dropConsoleBreadcrumbs(http)).toBe(http);
  });

  it('scrubbedError keeps a context, the name and a safe code — never the message', () => {
    expect(scrubbedError('ctx', 'a string MARKER').message).toBe('ctx (string)');
    expect(
      scrubbedError('ctx', Object.assign(new TypeError('MARKER'), { code: 'not safe MARKER' }))
        .message,
    ).toBe('ctx (TypeError)');
    expect(scrubbedError('ctx', null).message).toBe('ctx (object)');
  });

  it('the activity door ignores an instance that does not exist; the clock is the wall clock', async () => {
    await expect(agentInstanceActivityService.touchActivity(randomUUID())).resolves.toBe(undefined);
    const before = Date.now();
    expect(agentInstanceClock.now().getTime()).toBeGreaterThanOrEqual(before);
    const started = Date.now();
    await agentInstanceClock.sleep(15);
    expect(Date.now() - started).toBeGreaterThanOrEqual(10);
  });
});
