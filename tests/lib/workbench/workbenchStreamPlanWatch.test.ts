import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkbenchWatermarkDto } from '@/lib/dto/workbench';
import type { LiveNotification } from '@/lib/live/liveNotification';
import type { LiveSignalSubscriber } from '@/lib/live/liveSignalHub';
import type { WatchedPlan } from '@/lib/workbench/planWatch';
import {
  createWorkbenchStreamSession,
  WORKBENCH_STREAM_BACKSTOP_MS,
  WORKBENCH_STREAM_RECONNECT_JITTER_MS,
  type WorkbenchStreamActor,
  type WorkbenchStreamPlanReading,
} from '@/lib/workbench/workbenchStreamSession';
import {
  createWorkbenchStreamCoalescer,
  WORKBENCH_STREAM_COALESCE_MS,
  WORKBENCH_STREAM_READ_CONCURRENCY,
  type WorkbenchStreamCoalescer,
} from '@/lib/workbench/workbenchStreamCoalescer';

// PLAN FRAMES ON THE WORKBENCH STREAM (Story MOTIR-8542 · MOTIR-8730) — the
// session's second, independent handler, driven with a fake hub and fake timers.
// The leak half (a plan the reader cannot browse reads as null) is proven against
// real Postgres in `tests/integration/plans/planReviewVersionForReader.test.ts`;
// here `readPlan` is a stub and the assertions are about what the session does
// with its answers.

const ACTOR: WorkbenchStreamActor = { userId: 'u1', workspaceId: 'w1', projectId: 'p1' };

function fakeHub() {
  const subscribers = new Set<LiveSignalSubscriber>();
  return {
    subscribe: vi.fn((s: LiveSignalSubscriber) => {
      subscribers.add(s);
      return () => subscribers.delete(s);
    }),
    signal(n: Partial<LiveNotification> = {}) {
      const full: LiveNotification = { workspaceId: 'w1', projectId: 'p1', planId: 'plan-a', ...n };
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

const quiet = { warn: vi.fn() };
let coalescer: WorkbenchStreamCoalescer;

beforeEach(() => {
  vi.useFakeTimers();
  quiet.warn.mockReset();
  coalescer = createWorkbenchStreamCoalescer({ logger: quiet });
});

afterEach(() => {
  vi.useRealTimers();
});

/** A plan read whose version moves on every call: `v1`, `v2`, … */
function steppingPlanRead() {
  let n = 0;
  return vi.fn(async (_planId: string): Promise<WorkbenchStreamPlanReading> => {
    n += 1;
    return { status: 'generating', reviewVersion: `v${n}` };
  });
}

function open(
  watched: WatchedPlan[],
  readPlan: (planId: string) => Promise<WorkbenchStreamPlanReading> = steppingPlanRead(),
  hub = fakeHub(),
) {
  const read = vi.fn(
    async (): Promise<WorkbenchWatermarkDto> => ({
      cursor: 'c',
      moved: [],
      tabs: {} as WorkbenchWatermarkDto['tabs'],
    }),
  );
  const writePlan = vi.fn();
  const write = vi.fn();
  const session = createWorkbenchStreamSession({
    actor: ACTOR,
    hub,
    read,
    write,
    watched,
    readPlan,
    writePlan,
    coalescer,
    random: () => 0.5,
    logger: quiet,
  });
  return { hub, read, readPlan: vi.mocked(readPlan), write, writePlan, session };
}

/** Open, and let the opening plan reads settle. */
async function opened(...args: Parameters<typeof open>) {
  const parts = open(...args);
  await parts.session.start(null);
  await vi.advanceTimersByTimeAsync(0);
  return parts;
}

describe('AT OPEN', () => {
  it('writes nothing for a plan whose presented version is current', async () => {
    const readPlan = vi.fn(async () => ({ status: 'generating', reviewVersion: 'v1' }));
    const { writePlan } = await opened([{ planId: 'plan-a', version: 'v1' }], readPlan);

    expect(readPlan).toHaveBeenCalledTimes(1);
    expect(writePlan).not.toHaveBeenCalled();
  });

  it('writes exactly one frame for a stale version, and for no version at all', async () => {
    const readPlan = vi.fn(async () => ({ status: 'generating', reviewVersion: 'v2' }));
    const { writePlan } = await opened(
      [
        { planId: 'plan-a', version: 'v1' },
        { planId: 'plan-b', version: null },
      ],
      readPlan,
    );

    expect(writePlan).toHaveBeenCalledTimes(2);
    expect(writePlan).toHaveBeenCalledWith({ planId: 'plan-a', reviewVersion: 'v2' });
    expect(writePlan).toHaveBeenCalledWith({ planId: 'plan-b', reviewVersion: 'v2' });
  });

  it('a frame carries exactly the plan id and the review version', async () => {
    const { writePlan } = await opened([{ planId: 'plan-a', version: null }]);

    const frame = writePlan.mock.calls[0]![0];
    expect(Object.keys(frame).sort()).toEqual(['planId', 'reviewVersion']);
  });
});

describe('A SIGNAL FOR A WATCHED PLAN', () => {
  it('causes one plan read within the window, and a frame only when (status, version) moved', async () => {
    let answer: WorkbenchStreamPlanReading = { status: 'generating', reviewVersion: 'v1' };
    const readPlan = vi.fn(async () => answer);
    const { hub, writePlan } = await opened([{ planId: 'plan-a', version: 'v1' }], readPlan);

    hub.signal();
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_COALESCE_MS - 1);
    expect(readPlan).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(readPlan).toHaveBeenCalledTimes(2);
    expect(writePlan).not.toHaveBeenCalled(); // nothing moved

    // The status alone moving is enough: a plan leaving `generating` must reach the client.
    answer = { status: 'planned', reviewVersion: 'v1' };
    hub.signal();
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_COALESCE_MS);
    expect(writePlan).toHaveBeenCalledWith({ planId: 'plan-a', reviewVersion: 'v1' });

    answer = { status: 'planned', reviewVersion: 'v2' };
    hub.signal();
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_COALESCE_MS);
    expect(writePlan).toHaveBeenLastCalledWith({ planId: 'plan-a', reviewVersion: 'v2' });
    expect(writePlan).toHaveBeenCalledTimes(2);
  });

  it('coalesces 189 signals inside one window into ONE plan read', async () => {
    const { hub, readPlan } = await opened([{ planId: 'plan-a', version: null }]);
    readPlan.mockClear?.();

    for (let i = 0; i < 189; i += 1) hub.signal();
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_COALESCE_MS * 2);

    expect(readPlan).toHaveBeenCalledTimes(1);
  });

  it('never calls the watermark read from the plan handler', async () => {
    const { hub, read, readPlan } = await opened([{ planId: 'plan-a', version: null }]);
    read.mockClear();

    // A plan in ANOTHER project of the workspace: only the plan handler matches.
    hub.signal({ projectId: 'p-other' });
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_COALESCE_MS * 2);

    expect(readPlan).toHaveBeenCalledTimes(2);
    expect(read).not.toHaveBeenCalled();
  });

  it('the watermark handler is unchanged: a plan write in the reader’s project still re-reads it once', async () => {
    const { hub, read } = await opened([{ planId: 'plan-a', version: null }]);
    read.mockClear();

    for (let i = 0; i < 5; i += 1) hub.signal();
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_COALESCE_MS * 2);

    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('A SIGNAL THAT IS NOT FOR A WATCHED PLAN', () => {
  it('causes no plan read and no frame — another plan, or another workspace', async () => {
    const { hub, readPlan, writePlan } = await opened([{ planId: 'plan-a', version: 'v1' }]);
    readPlan.mockClear?.();
    writePlan.mockClear();

    hub.signal({ planId: 'plan-z' });
    hub.signal({ planId: null });
    hub.signal({ workspaceId: 'w2', planId: 'plan-a' });
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_COALESCE_MS * 4);

    expect(readPlan).not.toHaveBeenCalled();
    expect(writePlan).not.toHaveBeenCalled();
  });
});

describe('ONE PLAN READ IN FLIGHT', () => {
  it('a signal during a plan read causes exactly one follow-up, ending on the final version', async () => {
    let release: (() => void) | undefined;
    let n = 0;
    const readPlan = vi.fn(async (): Promise<WorkbenchStreamPlanReading> => {
      n += 1;
      const mine = n;
      if (mine === 2) await new Promise<void>((resolve) => (release = resolve));
      return { status: 'generating', reviewVersion: `v${mine}` };
    });
    const { hub, writePlan } = await opened([{ planId: 'plan-a', version: 'v1' }], readPlan);

    hub.signal();
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_COALESCE_MS);
    for (let i = 0; i < 3; i += 1) {
      hub.signal();
      await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_COALESCE_MS);
    }
    expect(readPlan).toHaveBeenCalledTimes(2);

    release!();
    await vi.advanceTimersByTimeAsync(0);

    expect(readPlan).toHaveBeenCalledTimes(3);
    expect(writePlan).toHaveBeenLastCalledWith({ planId: 'plan-a', reviewVersion: 'v3' });
  });
});

describe('A REFUSED OR VANISHED PLAN', () => {
  it('writes nothing for a null read, and a later read that answers still writes a frame', async () => {
    let answer: WorkbenchStreamPlanReading = null;
    const readPlan = vi.fn(async () => answer);
    const { hub, write, writePlan } = await opened([{ planId: 'plan-a', version: 'v1' }], readPlan);

    expect(writePlan).not.toHaveBeenCalled();
    expect(quiet.warn).not.toHaveBeenCalled();

    answer = { status: 'generating', reviewVersion: 'v2' };
    hub.signal();
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_COALESCE_MS);

    expect(writePlan).toHaveBeenCalledWith({ planId: 'plan-a', reviewVersion: 'v2' });
    expect(write).not.toHaveBeenCalled();
  });
});

describe('BACKSTOP AND RECONNECT', () => {
  it('a reconnect re-reads every watched plan', async () => {
    const { hub, readPlan } = await opened([
      { planId: 'plan-a', version: null },
      { planId: 'plan-b', version: null },
    ]);
    readPlan.mockClear?.();

    hub.reconnect();
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_RECONNECT_JITTER_MS);

    expect(readPlan.mock.calls.map((c) => c[0]).sort()).toEqual(['plan-a', 'plan-b']);
  });

  it('a lost plan notification is healed at WORKBENCH_STREAM_BACKSTOP_MS', async () => {
    const { readPlan, writePlan } = await opened([{ planId: 'plan-a', version: 'v1' }]);
    expect(writePlan).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_BACKSTOP_MS);

    expect(readPlan).toHaveBeenCalledTimes(2);
    expect(writePlan).toHaveBeenCalledWith({ planId: 'plan-a', reviewVersion: 'v2' });
  });
});

describe('BOUNDED FAN-OUT, shared with the project reads', () => {
  it('200 streams watching one plan: 200 reads, never more than the limit at once', async () => {
    let active = 0;
    let peak = 0;
    let slow = false;
    const readPlan = vi.fn(async (): Promise<WorkbenchStreamPlanReading> => {
      active += 1;
      peak = Math.max(peak, active);
      if (slow) await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { status: 'generating', reviewVersion: 'v' };
    });
    const hub = fakeHub();
    const sessions = Array.from({ length: 200 }, () =>
      open([{ planId: 'plan-a', version: 'v' }], readPlan, hub),
    );
    for (const s of sessions) await s.session.start(null);
    await vi.advanceTimersByTimeAsync(0);
    readPlan.mockClear();
    peak = 0;
    slow = true;

    // A signal from ANOTHER project, so only the plan handlers wake.
    hub.signal({ projectId: 'p-other' });
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_COALESCE_MS + 1_000);

    expect(readPlan).toHaveBeenCalledTimes(200);
    expect(peak).toBe(WORKBENCH_STREAM_READ_CONCURRENCY);
    for (const s of sessions) s.session.close();
  });
});

describe('CLEANUP', () => {
  it('after close no plan read runs and no frame is written', async () => {
    const { hub, readPlan, writePlan, session } = await opened([
      { planId: 'plan-a', version: 'v1' },
    ]);
    readPlan.mockClear?.();
    hub.signal();

    session.close();
    await vi.advanceTimersByTimeAsync(WORKBENCH_STREAM_BACKSTOP_MS * 2);

    expect(hub.count).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(readPlan).not.toHaveBeenCalled();
    expect(writePlan).not.toHaveBeenCalled();
  });
});
