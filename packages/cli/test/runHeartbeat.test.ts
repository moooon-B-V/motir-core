import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REPORTER_RUN_CLOSED_WARNING,
  RUN_HEARTBEAT_INTERVAL_MS,
  createDispatchRunReporter,
  type DispatchRunReporterDeps,
} from '../src/dispatchRunReporter.js';
import { INTERRUPT_EXIT_CODE, bindInterruptSignals, closeRunAndExit } from '../src/interrupt.js';
import type { DispatchRunOpened } from '../src/client.js';

// THE HEARTBEAT and THE INTERRUPT (Story MOTIR-6526 · MOTIR-6530).
//
// A fake clock drives the timer, so "one beat per interval, none after close"
// is asserted by counting calls rather than by waiting a minute. The interrupt
// is driven by calling the helpers directly — a test must never send itself a
// real SIGINT.

interface Calls {
  beats: string[];
  closes: string[];
  appends: number;
}

function fakeClient(
  beat: (runId: string, n: number) => Promise<'ok' | 'closed'> = async () => 'ok',
): { client: DispatchRunReporterDeps['client']; calls: Calls } {
  const calls: Calls = { beats: [], closes: [], appends: 0 };
  const client: DispatchRunReporterDeps['client'] = {
    async openDispatchRun(args): Promise<DispatchRunOpened> {
      return { runId: 'run_1', created: true, status: 'running', seq: 0, cards: args.cards };
    },
    async appendDispatchRunEvents(args) {
      calls.appends += args.events.length;
      return { runId: args.runId, appended: args.events.length, seq: calls.appends };
    },
    async closeDispatchRun(args) {
      calls.closes.push(args.stopReason);
    },
    async heartbeatDispatchRun(runId) {
      calls.beats.push(runId);
      return beat(runId, calls.beats.length);
    },
  };
  return { client, calls };
}

const OPEN = {
  projectKey: 'PROD',
  command: 'run' as const,
  runId: '20260927-100000',
  cards: [{ key: 'PROD-1', disposition: 'queued' as const }],
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the heartbeat — one beat per interval while the run is open', () => {
  it('beats every 60 s after open, and never after close', async () => {
    const { client, calls } = fakeClient();
    const reporter = createDispatchRunReporter({ client });
    await reporter.open(OPEN);

    expect(calls.beats).toEqual([]);
    await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
    expect(calls.beats).toEqual(['run_1']);
    await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS * 2);
    expect(calls.beats).toHaveLength(3);

    await reporter.close('completed');
    await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS * 5);
    expect(calls.beats).toHaveLength(3);
    expect(RUN_HEARTBEAT_INTERVAL_MS).toBe(60_000);
  });

  it('beats for an ADOPTED run too — the server-opened `fix` run is still a run', async () => {
    const { client, calls } = fakeClient();
    const reporter = createDispatchRunReporter({ client });
    reporter.adopt('run_fix');
    await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);
    expect(calls.beats).toEqual(['run_fix']);
    await reporter.close('completed');
  });

  it('a run that never opened sends nothing', async () => {
    const { client, calls } = fakeClient();
    createDispatchRunReporter({ client });
    await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS * 3);
    expect(calls.beats).toEqual([]);
  });

  it('`closed` (409) stops the timer and prints ONE line', async () => {
    const warnings: string[] = [];
    const { client, calls } = fakeClient(async (_id, n) => (n >= 2 ? 'closed' : 'ok'));
    const reporter = createDispatchRunReporter({ client, warn: (m) => warnings.push(m) });
    await reporter.open(OPEN);

    await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS * 5);
    expect(calls.beats).toHaveLength(2);
    expect(warnings).toEqual([REPORTER_RUN_CLOSED_WARNING]);
    // The run itself is unaffected: events still queue and close still runs.
    expect(reporter.offline).toBe(false);
  });

  it('any other failure is swallowed and the NEXT beat still goes — a blip never marks a live run dead', async () => {
    const warnings: string[] = [];
    const { client, calls } = fakeClient(async (_id, n) => {
      if (n === 1) throw new Error('network down');
      return 'ok';
    });
    const reporter = createDispatchRunReporter({ client, warn: (m) => warnings.push(m) });
    await reporter.open(OPEN);

    await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS * 3);
    expect(calls.beats).toHaveLength(3);
    expect(warnings).toEqual([]);
    expect(reporter.offline).toBe(false);
    await reporter.close('completed');
  });

  it('a client without the heartbeat method (an old fake) is simply not beaten for', async () => {
    const { client } = fakeClient();
    const { heartbeatDispatchRun: _drop, ...older } = client;
    const reporter = createDispatchRunReporter({ client: older });
    await reporter.open(OPEN);
    await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS * 2);
    await reporter.close('completed');
  });
});

describe('close is idempotent — an interrupt and the command can both reach it', () => {
  it('a second close sends nothing', async () => {
    const { client, calls } = fakeClient();
    const reporter = createDispatchRunReporter({ client });
    await reporter.open(OPEN);
    await reporter.close('interrupted');
    await reporter.close('completed');
    expect(calls.closes).toEqual(['interrupted']);
  });
});

describe('the interrupt — the run closes `interrupted`, queued events flushed first', () => {
  it('closeRunAndExit flushes, closes `interrupted`, then exits 130 on SIGINT', async () => {
    const { client, calls } = fakeClient();
    const reporter = createDispatchRunReporter({ client });
    await reporter.open(OPEN);
    reporter.event({ kind: 'agent_started', workItemKey: 'PROD-1' });
    reporter.event({ kind: 'log', workItemKey: 'PROD-1' });
    const exits: number[] = [];

    await closeRunAndExit(reporter, 'SIGINT', (code) => exits.push(code));

    expect(calls.appends).toBe(2);
    expect(calls.closes).toEqual(['interrupted']);
    expect(exits).toEqual([130]);
    // …and the heartbeat is gone with the run.
    await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS * 2);
    expect(calls.beats).toEqual([]);
  });

  it('exits 143 on SIGTERM', async () => {
    const { client } = fakeClient();
    const reporter = createDispatchRunReporter({ client });
    await reporter.open(OPEN);
    const exits: number[] = [];
    await closeRunAndExit(reporter, 'SIGTERM', (code) => exits.push(code));
    expect(exits).toEqual([143]);
    expect(INTERRUPT_EXIT_CODE).toEqual({ SIGINT: 130, SIGTERM: 143 });
  });

  it('bindInterruptSignals binds BOTH signals and its remover unbinds both', () => {
    const beforeInt = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    const seen: string[] = [];
    const detach = bindInterruptSignals((s) => seen.push(s));
    expect(process.listenerCount('SIGINT')).toBe(beforeInt + 1);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm + 1);
    process.listeners('SIGINT').at(-1)!('SIGINT');
    process.listeners('SIGTERM').at(-1)!('SIGTERM');
    expect(seen).toEqual(['SIGINT', 'SIGTERM']);
    detach();
    expect(process.listenerCount('SIGINT')).toBe(beforeInt);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
  });
});
