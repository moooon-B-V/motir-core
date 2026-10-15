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
