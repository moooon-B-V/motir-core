import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import {
  LIVE_SIGNAL_CHANNEL,
  parseLiveNotification,
  type LiveNotification,
} from '@/lib/live/liveNotification';
import {
  LIVE_SIGNAL_RECONNECT_MAX_MS,
  createLiveSignalHub,
  getLiveSignalHub,
  type LiveSignalHub,
} from '@/lib/live/liveSignalHub';

// The per-process live-signal hub (Story MOTIR-8542 · Subtask MOTIR-8728),
// against the worker's real Postgres: one LISTEN session however many
// subscribers, delivery to every subscriber, lazy start and idle stop, and a
// killed backend that reconnects and tells subscribers to catch up.

const url = (): string => process.env['DATABASE_URL']!;
// Captured before any test spies on it, so `until` never counts as a hub timer.
const realSetTimeout = globalThis.setTimeout;

let admin: Client;
const hubs: LiveSignalHub[] = [];

beforeEach(async () => {
  admin = new Client({ connectionString: url() });
  await admin.connect();
});

afterEach(async () => {
  await Promise.allSettled(hubs.splice(0).map((hub) => hub.stop()));
  await admin.end();
});

function quietLog() {
  const info: unknown[][] = [];
  const warn: unknown[][] = [];
  return {
    info,
    warn,
    logger: {
      info: (...a: unknown[]) => info.push(a),
      warn: (...a: unknown[]) => warn.push(a),
    },
  };
}

function makeHub(opts: Parameters<typeof createLiveSignalHub>[0] = {}): LiveSignalHub {
  const hub = createLiveSignalHub({ connectionString: url(), ...opts });
  hubs.push(hub);
  return hub;
}

/** Wait on a CONDITION, never on a duration. */
async function until(cond: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (await cond()) return;
    await new Promise((r) => realSetTimeout(r, 10));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

async function listeningSessions(): Promise<number[]> {
  const r = await admin.query<{ pid: number }>(
    `SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND query = $1 AND pid <> pg_backend_pid()`,
    [`LISTEN ${LIVE_SIGNAL_CHANNEL}`],
  );
  return r.rows.map((row) => row.pid);
}

async function notify(payload: string): Promise<void> {
  await admin.query('SELECT pg_notify($1, $2)', [LIVE_SIGNAL_CHANNEL, payload]);
}

describe('parseLiveNotification', () => {
  it('reads the ids-only payload', () => {
    expect(parseLiveNotification('{"w":"w1","p":"p1","plan":null}')).toEqual({
      workspaceId: 'w1',
      projectId: 'p1',
      planId: null,
    });
    expect(parseLiveNotification('{"w":"w1","p":null,"plan":"pl1"}')).toEqual({
      workspaceId: 'w1',
      projectId: null,
      planId: 'pl1',
    });
  });

  it('answers null for anything malformed, and never throws', () => {
    for (const raw of [
      '',
      'not json',
      '[]',
      'null',
      '"w1"',
      '{}',
      '{"w":""}',
      '{"w":42}',
      '{"w":"w1","p":7}',
      '{"w":"w1","plan":{"id":"x"}}',
      `{"w":"${'x'.repeat(65)}"}`,
      `{"w":"w1","p":"${'x'.repeat(65)}"}`,
    ]) {
      expect(parseLiveNotification(raw), raw).toBeNull();
    }
  });
});

describe('the live-signal hub', () => {
  it('fans one NOTIFY out to every subscriber through ONE listening session', async () => {
    const hub = makeHub(quietLog());
    const a: LiveNotification[] = [];
    const b: LiveNotification[] = [];
    hub.subscribe({ onSignal: (n) => a.push(n) });
    hub.subscribe({ onSignal: (n) => b.push(n) });
    await until(() => hub.connected, 'connected');

    expect(await listeningSessions()).toHaveLength(1);

    await notify('{"w":"w1","p":"p1","plan":null}');
    await until(() => a.length === 1 && b.length === 1, 'both subscribers received it');
    expect(a[0]).toEqual({ workspaceId: 'w1', projectId: 'p1', planId: null });
    expect(b[0]).toEqual(a[0]);
  });

  it('holds one session for several hundred subscribers, adding no emitter listeners', async () => {
    const hub = makeHub(quietLog());
    const seen = { count: 0 };
    const unsubscribes = Array.from({ length: 300 }, () =>
      hub.subscribe({ onSignal: () => (seen.count += 1) }),
    );
    await until(() => hub.connected, 'connected');
    expect(await listeningSessions()).toHaveLength(1);
    await notify('{"w":"w1","p":null,"plan":null}');
    await until(() => seen.count === 300, 'all 300 received it');
    for (const off of unsubscribes) off();
  });

  it('stops delivering to a subscriber that unsubscribed', async () => {
    const hub = makeHub(quietLog());
    const kept: LiveNotification[] = [];
    const dropped: LiveNotification[] = [];
    hub.subscribe({ onSignal: (n) => kept.push(n) });
    const off = hub.subscribe({ onSignal: (n) => dropped.push(n) });
    await until(() => hub.connected, 'connected');
    off();
    off(); // idempotent
    expect(hub.subscriberCount).toBe(1);

    await notify('{"w":"w1","p":"p1","plan":null}');
    await until(() => kept.length === 1, 'the kept subscriber received it');
    expect(dropped).toHaveLength(0);
  });

  it('closes the session after the last unsubscribe and the idle delay, and reopens on a new subscribe', async () => {
    const hub = makeHub({ ...quietLog(), idleCloseMs: 20 });
    const off = hub.subscribe({ onSignal: () => {} });
    await until(() => hub.connected, 'connected');
    expect(await listeningSessions()).toHaveLength(1);

    off();
    await until(async () => (await listeningSessions()).length === 0, 'the session closed');
    expect(hub.connected).toBe(false);

    const got: LiveNotification[] = [];
    hub.subscribe({ onSignal: (n) => got.push(n) });
    await until(() => hub.connected, 'reconnected');
    expect(await listeningSessions()).toHaveLength(1);
    await notify('{"w":"w2","p":null,"plan":"pl"}');
    await until(() => got.length === 1, 'delivered after reopening');
  });

  it('keeps the session when a subscriber arrives inside the idle delay', async () => {
    const hub = makeHub({ ...quietLog(), idleCloseMs: 60_000 });
    const off = hub.subscribe({ onSignal: () => {} });
    await until(() => hub.connected, 'connected');
    const [pid] = await listeningSessions();
    off();
    hub.subscribe({ onSignal: () => {} });
    expect(hub.connected).toBe(true);
    expect(await listeningSessions()).toEqual([pid]);
  });

  it('reconnects after its backend is killed, logs one warn and one info, and calls onReconnect', async () => {
    const log = quietLog();
    const hub = makeHub({ ...log, reconnectBaseMs: 20 });
    let reconnects = 0;
    const got: LiveNotification[] = [];
    hub.subscribe({ onSignal: (n) => got.push(n), onReconnect: () => (reconnects += 1) });
    hub.subscribe({ onSignal: () => {} });
    await until(() => hub.connected, 'connected');
    const afterFirstConnect = reconnects;
    expect(afterFirstConnect).toBe(1);
    expect(log.warn).toHaveLength(0);
    expect(log.info).toHaveLength(0);

    const [pid] = await listeningSessions();
    await admin.query('SELECT pg_terminate_backend($1)', [pid]);
    await until(() => reconnects === afterFirstConnect + 1, 'onReconnect after the kill');

    expect(hub.connected).toBe(true);
    expect(log.warn).toHaveLength(1);
    expect(String(log.warn[0]![0])).toContain(
      '[live-signal] listener down; pages heal on the 60 s backstop',
    );
    expect(log.info).toHaveLength(1);
    const pids = await listeningSessions();
    expect(pids).toHaveLength(1);
    expect(pids[0]).not.toBe(pid);

    await notify('{"w":"w1","p":"p1","plan":null}');
    await until(() => got.length === 1, 'delivered on the new session');
  });

  it('backs off no further than the ceiling while the database is unreachable', async () => {
    const log = quietLog();
    const hub = createLiveSignalHub({
      ...log,
      connectionString: 'postgresql://nobody:nobody@127.0.0.1:1/nothing',
    });
    hubs.push(hub);
    const delays: number[] = [];
    // Record each retry's requested delay, then run it at once.
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      delays.push(ms ?? 0);
      return realSetTimeout(fn, 0);
    }) as typeof setTimeout);
    try {
      hub.subscribe({ onSignal: () => {} });
      await until(() => delays.length >= 8, 'eight reconnect attempts');
    } finally {
      spy.mockRestore();
    }
    await hub.stop();
    expect(delays.slice(0, 8)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
    expect(Math.max(...delays)).toBe(LIVE_SIGNAL_RECONNECT_MAX_MS);
    // One degraded line for the whole outage, not one per retry.
    expect(log.warn).toHaveLength(1);
    expect(hub.connected).toBe(false);
  });

  it('drops a malformed payload and keeps delivering', async () => {
    const hub = makeHub(quietLog());
    const got: LiveNotification[] = [];
    hub.subscribe({ onSignal: (n) => got.push(n) });
    await until(() => hub.connected, 'connected');

    await notify('not json');
    await notify(`{"w":"${'x'.repeat(200)}"}`);
    await notify('{"w":"ok","p":null,"plan":null}');
    await until(() => got.length === 1, 'the valid one arrived');
    expect(got).toEqual([{ workspaceId: 'ok', projectId: null, planId: null }]);
    expect(hub.connected).toBe(true);
  });

  it('a subscriber that throws does not starve the ones after it', async () => {
    const log = quietLog();
    const hub = makeHub(log);
    const after: LiveNotification[] = [];
    hub.subscribe({
      onSignal: () => {
        throw new Error('boom');
      },
    });
    hub.subscribe({ onSignal: (n) => after.push(n) });
    await until(() => hub.connected, 'connected');
    await notify('{"w":"w1","p":null,"plan":null}');
    await until(() => after.length === 1, 'the later subscriber received it');
    expect(log.warn.some((line) => String(line[0]).includes('a subscriber threw'))).toBe(true);
  });

  it('stop() is idempotent and leaves no session behind', async () => {
    const hub = makeHub(quietLog());
    hub.subscribe({ onSignal: () => {} });
    await until(() => hub.connected, 'connected');
    await hub.stop();
    await expect(hub.stop()).resolves.toBeUndefined();
    expect(hub.subscriberCount).toBe(0);
    await until(async () => (await listeningSessions()).length === 0, 'no session left');
  });
});

describe('getLiveSignalHub', () => {
  it('answers one instance per process, even from a re-imported module', async () => {
    const first = getLiveSignalHub();
    expect(getLiveSignalHub()).toBe(first);
    vi.resetModules();
    const again = await import('@/lib/live/liveSignalHub');
    expect(again.getLiveSignalHub()).toBe(first);
    await first.stop();
  });
});

describe('the module source', () => {
  const read = (p: string) => readFileSync(resolve(__dirname, '../../..', p), 'utf8');

  it('issues no statement but LISTEN, and reads the unpooled URL first', () => {
    const src = read('lib/live/liveSignalHub.ts');
    const queries = [...src.matchAll(/\.query\(\s*`([^`]*)`/g)].map((m) => m[1]);
    expect(queries).toEqual(['LISTEN ${LIVE_SIGNAL_CHANNEL}']);
    expect(src.indexOf("process.env['DATABASE_URL_UNPOOLED']")).toBeGreaterThan(-1);
    expect(src.indexOf("process.env['DATABASE_URL_UNPOOLED']")).toBeLessThan(
      src.indexOf("process.env['DATABASE_URL']"),
    );
  });

  it('keeps the server contract out of the client seam', () => {
    const src = read('lib/live/liveNotification.ts');
    expect(src).not.toMatch(/^\s*['"]use client['"];?\s*$/m);
    expect(src).not.toMatch(/^import /m);
  });
});

// ── THE EDGE ARMS (Story MOTIR-8542 · MOTIR-8733) ──────────────────────────
// The story gate's per-file coverage floor named the arms no case above reached:
// the URL fallback, a hub stopped while its session was still connecting, and
// what the client itself can hand back (a non-Error failure, a payload-less
// notification). The last three drive the client's own methods, because a real
// server never produces them on demand.

describe('the hub, at its edges', () => {
  it('falls back to DATABASE_URL when no unpooled URL is configured', async () => {
    const saved = process.env['DATABASE_URL_UNPOOLED'];
    delete process.env['DATABASE_URL_UNPOOLED'];
    try {
      const hub = createLiveSignalHub(quietLog());
      hubs.push(hub);
      hub.subscribe({ onSignal: () => {} });
      await until(() => hub.connected, 'connected on DATABASE_URL');
    } finally {
      if (saved !== undefined) process.env['DATABASE_URL_UNPOOLED'] = saved;
    }
  });

  it('a hub stopped while its session is still connecting logs nothing and keeps nothing', async () => {
    const log = quietLog();
    const hub = createLiveSignalHub({
      ...log,
      connectionString: 'postgresql://nobody:nobody@127.0.0.1:1/nothing',
    });
    hubs.push(hub);
    hub.subscribe({ onSignal: () => {} });
    await hub.stop();
    await new Promise((r) => realSetTimeout(r, 200));
    expect(log.warn).toEqual([]);
    expect(hub.connected).toBe(false);
  });

  it('a session that finishes connecting after stop() is closed, never used', async () => {
    let finish!: () => void;
    const connect = vi
      .spyOn(Client.prototype, 'connect')
      .mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)) as never);
    const query = vi.spyOn(Client.prototype, 'query').mockResolvedValue({} as never);
    const end = vi.spyOn(Client.prototype, 'end').mockResolvedValue(undefined as never);
    try {
      const hub = makeHub(quietLog());
      hub.subscribe({ onSignal: () => {} });
      await hub.stop();
      finish();
      await until(() => end.mock.calls.length >= 2, 'the late session closed');
      expect(hub.connected).toBe(false);
    } finally {
      connect.mockRestore();
      query.mockRestore();
      end.mockRestore();
    }
  });

  it('logs a non-Error failure as itself, and drops a notification with no payload', async () => {
    const log = quietLog();
    let calls = 0;
    const connect = vi.spyOn(Client.prototype, 'connect').mockImplementation(() => {
      calls += 1;
      return (calls === 1 ? Promise.reject('refused') : Promise.resolve()) as never;
    });
    // The client the hub is listening on: the one its latest connect was called on.
    const current = () => connect.mock.contexts.at(-1) as Client;
    const query = vi.spyOn(Client.prototype, 'query').mockResolvedValue({} as never);
    const end = vi.spyOn(Client.prototype, 'end').mockResolvedValue(undefined as never);
    const timer = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((fn: () => void) => realSetTimeout(fn, 0)) as typeof setTimeout);
    try {
      const hub = makeHub({ ...log, logger: log.logger });
      const got: LiveNotification[] = [];
      const caughtUp: string[] = [];
      hub.subscribe({
        onSignal: () => {},
        onReconnect: () => {
          throw new Error('a subscriber broke');
        },
      });
      hub.subscribe({ onSignal: (n) => got.push(n), onReconnect: () => caughtUp.push('second') });
      await until(() => hub.connected, 'connected on the retry');
      expect(log.warn[0]?.[1]).toBe('refused');
      // One subscriber throwing on reconnect does not stop the next being told.
      expect(log.warn.some((w) => String(w[0]).includes('threw on reconnect'))).toBe(true);
      expect(caughtUp).toEqual(['second']);
      current().emit('notification', { channel: LIVE_SIGNAL_CHANNEL, payload: undefined });
      expect(got).toEqual([]);
      // The session ENDING (rather than erroring) is a drop too.
      current().emit('end');
      expect(hub.connected).toBe(false);
    } finally {
      timer.mockRestore();
      connect.mockRestore();
      query.mockRestore();
      end.mockRestore();
    }
  });
});
