import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkbenchTabKey, WorkbenchWatermarkDto } from '@/lib/dto/workbench';
import type { LiveNotification } from '@/lib/live/liveNotification';
import type { LiveSignalSubscriber } from '@/lib/live/liveSignalHub';
import {
  createWorkbenchStreamSession,
  WORKBENCH_STREAM_BACKSTOP_MS,
  WORKBENCH_STREAM_RECONNECT_JITTER_MS,
  type WorkbenchStreamActor,
} from '@/lib/workbench/workbenchStreamSession';
import {
  createWorkbenchStreamCoalescer,
  WORKBENCH_STREAM_COALESCE_MS,
  WORKBENCH_STREAM_READ_CONCURRENCY,
  type WorkbenchStreamCoalescer,
} from '@/lib/workbench/workbenchStreamCoalescer';

// THE WORKBENCH STREAM SESSION (Story MOTIR-8542 · Subtask MOTIR-8729) — the read
// lifecycle behind one open stream, driven with a fake hub and fake timers so the
// read count can be asserted exactly. The route test drives the same session end
// to end against real Postgres and the real listener.

const ACTOR: WorkbenchStreamActor = { userId: 'u1', workspaceId: 'w1', projectId: 'p1' };

function fakeHub() {
  const subscribers = new Set<LiveSignalSubscriber>();
  const unsubscribe = vi.fn();
  return {
    unsubscribe,
    subscribe: vi.fn((s: LiveSignalSubscriber) => {
      subscribers.add(s);
      return () => {
        unsubscribe();
        subscribers.delete(s);
      };
    }),
    signal(n: Partial<LiveNotification> = {}) {
      const full: LiveNotification = { workspaceId: 'w1', projectId: 'p1', planId: null, ...n };
      for (const s of [...subscribers]) s.onSignal(full);
    },
    reconnect() {
      for (const s of [...subscribers]) s.onReconnect?.();
    },
    get count() {
      return subscribers.size;
    },
  };
}

function reading(cursor: string, moved: WorkbenchTabKey[] = []): WorkbenchWatermarkDto {
  return { cursor, moved, tabs: {} as WorkbenchWatermarkDto['tabs'] };
}

/** A read stub whose answer changes on every call: cursor `c<n>`, moving `toDo` after the first. */
function steppingRead() {
  let n = 0;
  return vi.fn(async (_actor: WorkbenchStreamActor, _since: string | null) => {
    n += 1;
    return reading(`c${n}`, n === 1 ? [] : ['toDo']);
  });
}

let coalescer: WorkbenchStreamCoalescer;
const quiet = { warn: vi.fn() };

beforeEach(() => {
  vi.useFakeTimers();
  coalescer = createWorkbenchStreamCoalescer({ logger: quiet });
  quiet.warn.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

function open(
  opts: { read?: ReturnType<typeof steppingRead>; hub?: ReturnType<typeof fakeHub> } = {},
) {
  const hub = opts.hub ?? fakeHub();
  const read = opts.read ?? steppingRead();
  const write = vi.fn();
  const session = createWorkbenchStreamSession({
    actor: ACTOR,
    hub,
    read,
    write,
    coalescer,
    random: () => 0.5,
    logger: quiet,
  });
  return { hub, read, write, session };
}

describe('A QUIET STREAM', () => {
  it('reads once on open and then only on the backstop: at most 5 reads in 5 minutes', async () => {
    const { read, session } = open();
    await session.start(null);
    expect(read).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(read.mock.calls.length).toBeGreaterThan(1);
    expect(read.mock.calls.length).toBeLessThanOrEqual(1 + 5);
    session.close();
  });

  it('heals a lost notification with the backstop read at WORKBENCH_STREAM_BACKSTOP_MS', async () => {
    const { read, write, session } = open();
    await session.start(null);

    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_BACKSTOP_MS - 1);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ cursor: 'c2' }));
    session.close();
  });
});

describe('A NOTIFICATION', () => {
  it('causes exactly one re-read, no later than WORKBENCH_STREAM_COALESCE_MS', async () => {
    const { hub, read, session } = open();
    await session.start(null);

    hub.signal();
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_COALESCE_MS - 1);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_COALESCE_MS * 4);
    expect(read).toHaveBeenCalledTimes(2);
    session.close();
  });

  it('coalesces 189 notifications for one project inside one window into ONE re-read', async () => {
    const { hub, read, session } = open();
    await session.start(null);

    for (let i = 0; i < 189; i += 1) hub.signal();
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_COALESCE_MS * 2);

    expect(read).toHaveBeenCalledTimes(2);
    session.close();
  });

  it('causes no re-read for another workspace, or for a project outside the reader’s scope', async () => {
    const { hub, read, session } = open();
    await session.start(null);

    hub.signal({ workspaceId: 'w2' });
    hub.signal({ workspaceId: 'w2', projectId: null });
    hub.signal({ projectId: 'p2' });
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_COALESCE_MS * 4);

    expect(read).toHaveBeenCalledTimes(1);
    session.close();
  });

  it('re-reads for a write that names the workspace and no project', async () => {
    const { hub, read, session } = open();
    await session.start(null);

    hub.signal({ projectId: null });
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_COALESCE_MS);

    expect(read).toHaveBeenCalledTimes(2);
    session.close();
  });

  it('re-reads from the cursor the last read returned', async () => {
    const { hub, read, session } = open();
    await session.start('presented');
    expect(read).toHaveBeenLastCalledWith(ACTOR, 'presented');

    hub.signal();
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_COALESCE_MS);
    expect(read).toHaveBeenLastCalledWith(ACTOR, 'c1');
    session.close();
  });
});

describe('ONE READ IN FLIGHT', () => {
  it('a notification during a read causes exactly one follow-up, ending on the final state', async () => {
    let release: (() => void) | undefined;
    let n = 0;
    const read = vi.fn(async () => {
      n += 1;
      const mine = n;
      if (mine === 2) await new Promise<void>((resolve) => (release = resolve));
      return reading(`c${mine}`, mine === 1 ? [] : ['toDo']);
    });
    const { hub, write, session } = open({ read });
    await session.start(null);

    hub.signal();
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_COALESCE_MS);
    expect(read).toHaveBeenCalledTimes(2); // in flight, held

    // Three more windows' worth of writes land while it is held.
    for (let i = 0; i < 3; i += 1) {
      hub.signal();
      await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_COALESCE_MS);
    }
    expect(read).toHaveBeenCalledTimes(2);

    release!();
    await vi.advanceTimersByTimeAsync(0);

    expect(read).toHaveBeenCalledTimes(3);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls.at(-1)![0].cursor).toBe('c3');
    session.close();
  });

  it('a write that commits during the OPENING read is read straight after it', async () => {
    let release: (() => void) | undefined;
    let n = 0;
    const hub = fakeHub();
    const read = vi.fn(async () => {
      n += 1;
      const mine = n;
      if (mine === 1) await new Promise<void>((resolve) => (release = resolve));
      return reading(`c${mine}`, mine === 1 ? [] : ['inProgress']);
    });
    const { write, session } = open({ read, hub });
    const starting = session.start(null);
    // Subscribed BEFORE the read.
    expect(hub.count).toBe(1);

    hub.signal();
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_COALESCE_MS);
    release!();
    const opening = await starting;
    await vi.advanceTimersByTimeAsync(0);

    expect(opening.cursor).toBe('c1');
    expect(read).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ cursor: 'c2' }));
    session.close();
  });
});

describe('THE FRAME', () => {
  it('is written only when something moved, and the held cursor moves either way', async () => {
    let n = 0;
    const read = vi.fn(async () => {
      n += 1;
      return reading(`c${n}`, n === 3 ? ['watching'] : []);
    });
    const { hub, write, session } = open({ read });
    await session.start(null);

    hub.signal();
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_COALESCE_MS);
    expect(write).not.toHaveBeenCalled();

    hub.signal();
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_COALESCE_MS);
    expect(read).toHaveBeenLastCalledWith(ACTOR, 'c2');
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(reading('c3', ['watching']));
    session.close();
  });
});

describe('THE HUB RECONNECTS', () => {
  it('a reconnect triggers a catch-up read within 1 s', async () => {
    const { hub, read, session } = open();
    await session.start(null);

    hub.reconnect();
    hub.reconnect();
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_RECONNECT_JITTER_MS);

    expect(read).toHaveBeenCalledTimes(2);
    session.close();
  });
});

describe('CLEANUP — nothing runs and nothing is written after the session closes', () => {
  it('unsubscribes and clears every timer on close', async () => {
    const { hub, read, write, session } = open();
    await session.start(null);
    hub.signal();
    hub.reconnect();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    session.close();
    session.close();

    expect(hub.unsubscribe).toHaveBeenCalledTimes(1);
    expect(hub.count).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(coalescer.openWindows).toBe(0);
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_BACKSTOP_MS * 3);
    expect(read).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
  });

  it('drops a read that was in flight when it closed', async () => {
    let release: (() => void) | undefined;
    let n = 0;
    const read = vi.fn(async () => {
      n += 1;
      const mine = n;
      if (mine === 2) await new Promise<void>((resolve) => (release = resolve));
      return reading(`c${mine}`, ['toDo']);
    });
    const { hub, write, session } = open({ read });
    await session.start(null);
    hub.signal();
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_COALESCE_MS);

    session.close();
    release!();
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_BACKSTOP_MS);

    expect(write).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  // ⚠️ CLOSING SETTLES (MOTIR-8812). A re-read is a transaction under the
  // reader's context; a close that returned while one ran let the route's
  // `cancel()` end the request with that transaction still open in the pool.
  it('close() settles only once a re-read already in flight has settled', async () => {
    let release: (() => void) | undefined;
    let n = 0;
    const read = vi.fn(async () => {
      n += 1;
      const mine = n;
      if (mine === 2) await new Promise<void>((resolve) => (release = resolve));
      return reading(`c${mine}`, ['toDo']);
    });
    const { hub, write, session } = open({ read });
    await session.start(null);
    hub.signal();
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_COALESCE_MS);
    expect(read).toHaveBeenCalledTimes(2);

    let settled = false;
    const closing = session.close().then(() => {
      settled = true;
    });
    // Everything else stops AT ONCE — only the running read is waited for.
    expect(hub.count).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    release!();
    await closing;
    expect(settled).toBe(true);
    expect(write).not.toHaveBeenCalled();
    // A second close answers the same, already-settled wait.
    await expect(session.close()).resolves.toBeUndefined();
  });

  it('close() during the OPENING read waits for it, and a throw there never rejects the close', async () => {
    let fail!: (e: unknown) => void;
    const read = vi.fn(() => new Promise<WorkbenchWatermarkDto>((_, reject) => (fail = reject)));
    const { session } = open({ read: read as unknown as ReturnType<typeof steppingRead> });
    const starting = session.start(null);

    let settled = false;
    const closing = session.close().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    fail(new Error('the reader left'));
    await expect(starting).rejects.toThrow('the reader left');
    await closing;
    expect(settled).toBe(true);
  });

  it('close() waits for a watched plan read in flight too', async () => {
    let answer!: (r: { status: string; reviewVersion: string }) => void;
    const writePlan = vi.fn();
    const session = createWorkbenchStreamSession({
      actor: ACTOR,
      hub: fakeHub(),
      read: steppingRead(),
      write: vi.fn(),
      watched: [{ planId: 'plan-a', version: null }],
      readPlan: () => new Promise((resolve) => (answer = resolve)),
      writePlan,
      coalescer,
      random: () => 0.5,
      logger: quiet,
    });
    await session.start(null);
    await vi.advanceTimersByTimeAsync(0);

    let settled = false;
    const closing = session.close().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    answer({ status: 'planned', reviewVersion: 'v2' });
    await closing;
    expect(settled).toBe(true);
    expect(writePlan).not.toHaveBeenCalled();
  });

  it('close() with no read in flight settles at once', async () => {
    const { session } = open();
    await session.start(null);
    await expect(session.close()).resolves.toBeUndefined();
  });

  it('a throw in the opening read closes the session and propagates', async () => {
    const read = vi.fn(async () => {
      throw new Error('the database went away');
    });
    const { hub, session } = open({ read: read as unknown as ReturnType<typeof steppingRead> });

    await expect(session.start(null)).rejects.toThrow('the database went away');

    expect(hub.unsubscribe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('A RE-READ THAT THROWS', () => {
  it('is logged, keeps the stream open, and the next notification retries', async () => {
    let n = 0;
    const read = vi.fn(async () => {
      n += 1;
      if (n === 2) throw new Error('pool timeout');
      return reading(`c${n}`, n === 1 ? [] : ['toDo']);
    });
    const { hub, write, session } = open({ read });
    await session.start(null);

    hub.signal();
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_COALESCE_MS);
    expect(quiet.warn).toHaveBeenCalledTimes(1);
    expect(hub.unsubscribe).not.toHaveBeenCalled();

    hub.signal();
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_COALESCE_MS);
    expect(read).toHaveBeenCalledTimes(3);
    // The retry starts from the last cursor that was actually read.
    expect(read).toHaveBeenLastCalledWith(ACTOR, 'c1');
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ cursor: 'c3' }));
    session.close();
  });

  it('is retried by the backstop when no notification comes', async () => {
    let n = 0;
    const read = vi.fn(async () => {
      n += 1;
      if (n === 2) throw new Error('pool timeout');
      return reading(`c${n}`);
    });
    const { hub, session } = open({ read });
    await session.start(null);
    hub.signal();
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_COALESCE_MS);

    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_BACKSTOP_MS);
    expect(read).toHaveBeenCalledTimes(3);
    session.close();
  });
});

describe('BOUNDED FAN-OUT', () => {
  it('200 streams on one project: one window, 200 reads, never more than the limit at once', async () => {
    let active = 0;
    let peak = 0;
    // The opening reads answer at once; the window's reads each take 5 ms of
    // (fake) time, so they overlap and the limit is what bounds them.
    let slow = false;
    const read = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      if (slow) await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return reading('c', []);
    });
    const hub = fakeHub();
    const sessions = Array.from({ length: 200 }, () =>
      createWorkbenchStreamSession({ actor: ACTOR, hub, read, write: vi.fn(), coalescer }),
    );
    for (const s of sessions) await s.start(null);
    read.mockClear();
    peak = 0;
    slow = true;

    hub.signal();
    expect(coalescer.openWindows).toBe(1);
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_COALESCE_MS + 1_000);

    expect(read).toHaveBeenCalledTimes(200);
    expect(peak).toBe(WORKBENCH_STREAM_READ_CONCURRENCY);
    for (const s of sessions) s.close();
    expect(hub.count).toBe(0);
  });
});

describe('THE LAYERING', () => {
  it('the session and the coalescer import no repository, no db and no service', () => {
    for (const file of [
      'lib/workbench/workbenchStreamSession.ts',
      'lib/workbench/workbenchStreamCoalescer.ts',
    ]) {
      const source = readFileSync(path.join(process.cwd(), file), 'utf8');
      expect(source, file).not.toMatch(/from '@\/lib\/(repositories|services)\//);
      expect(source, file).not.toMatch(/from '@\/lib\/db'/);
    }
  });
});

// ── THE EDGE ARMS (Story MOTIR-8542 · MOTIR-8733) ──────────────────────────
// The story gate's per-file coverage floor named the arms no case above reached:
// a read waiting for a limiter slot, a session closed while it waited, a
// non-Error throw, a start after close, and an un-listen called twice.

describe('THE EDGE ARMS', () => {
  /** A one-slot limiter whose slot the test holds, so reads queue behind it. */
  async function heldSlot(c: WorkbenchStreamCoalescer): Promise<() => void> {
    let release!: () => void;
    void c.run(() => new Promise<void>((resolve) => (release = resolve)));
    await vi.advanceTimersByTimeAsync(0);
    return () => release();
  }

  function narrowSession(
    opts: {
      read?: (a: WorkbenchStreamActor, s: string | null) => Promise<WorkbenchWatermarkDto>;
      readPlan?: (planId: string) => Promise<{ status: string; reviewVersion: string } | null>;
      watched?: { planId: string; version: string | null }[];
    } = {},
  ) {
    const narrow = createWorkbenchStreamCoalescer({ concurrency: 1, logger: quiet });
    const hub = fakeHub();
    const read = vi.fn(opts.read ?? steppingRead());
    const write = vi.fn();
    const writePlan = vi.fn();
    const session = createWorkbenchStreamSession({
      actor: ACTOR,
      hub,
      read,
      write,
      coalescer: narrow,
      random: () => 0.5,
      logger: quiet,
      ...(opts.readPlan ? { readPlan: opts.readPlan, writePlan } : {}),
      ...(opts.watched ? { watched: opts.watched } : {}),
    });
    return { narrow, hub, read, write, writePlan, session };
  }

  it('a second window while a read waits for a slot asks for nothing more', async () => {
    const { narrow, hub, read, session } = narrowSession();
    await session.start(null);
    const release = await heldSlot(narrow);

    hub.signal();
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_COALESCE_MS);
    hub.signal();
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_COALESCE_MS);
    expect(narrow.queuedReads).toBe(1);

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    session.close();
  });

  it('a session closed while its reads waited for a slot reads nothing when the slot frees', async () => {
    const readPlan = vi.fn(async () => ({ status: 'generating', reviewVersion: 'v2' }));
    const { narrow, hub, read, writePlan, session } = narrowSession({
      readPlan,
      watched: [{ planId: 'plan-a', version: 'v1' }],
    });
    const release = await heldSlot(narrow);
    const started = session.start(null);
    await vi.advanceTimersByTimeAsync(0);
    await started;
    // The opening plan read is queued; a reconnect asks for it again, and is absorbed.
    hub.reconnect();
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_RECONNECT_JITTER_MS);
    hub.signal();
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_COALESCE_MS);

    session.close();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    expect(readPlan).not.toHaveBeenCalled();
    expect(writePlan).not.toHaveBeenCalled();
  });

  it('a non-Error throw is logged as itself, on the watermark read and on a plan read', async () => {
    let n = 0;
    const { hub, session } = narrowSession({
      read: async () => {
        n += 1;
        if (n === 2) throw 'pool exhausted';
        return reading(`c${n}`);
      },
      readPlan: async () => {
        throw 'plan read refused';
      },
      watched: [{ planId: 'plan-a', version: null }],
    });
    await session.start(null);
    await vi.advanceTimersByTimeAsync(0);
    hub.signal();
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_COALESCE_MS);

    const logged = quiet.warn.mock.calls.map((c) => c[1]);
    expect(logged).toContain('pool exhausted');
    expect(logged).toContain('plan read refused');
    session.close();
  });

  it('a plan read that throws after close logs nothing', async () => {
    let fail!: (e: unknown) => void;
    const { session } = narrowSession({
      readPlan: () => new Promise((_, reject) => (fail = reject)),
      watched: [{ planId: 'plan-a', version: null }],
    });
    await session.start(null);
    await vi.advanceTimersByTimeAsync(0);
    session.close();
    fail(new Error('too late'));
    await vi.advanceTimersByTimeAsync(0);
    expect(quiet.warn).not.toHaveBeenCalled();
  });

  it('a readPlan with no watched list watches nothing', async () => {
    const readPlan = vi.fn(async () => null);
    const { session } = narrowSession({ readPlan });
    await session.start(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(readPlan).not.toHaveBeenCalled();
    session.close();
  });

  it('refuses to start once closed', async () => {
    const { session } = narrowSession();
    session.close();
    await expect(session.start(null)).rejects.toThrow('closed');
  });

  it('the coalescer: an un-listen called twice removes once, and a window with no listener tells nobody', async () => {
    const c = createWorkbenchStreamCoalescer({ logger: quiet });
    const told = vi.fn();
    const off = c.listen('k', told);
    off();
    off();
    c.touch('k');
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_COALESCE_MS);
    expect(told).not.toHaveBeenCalled();
    expect(c.openWindows).toBe(0);
  });
});
