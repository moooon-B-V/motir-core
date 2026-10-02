import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDispatchLeg } from '../src/dispatchLeg.js';
import {
  RUN_HEARTBEAT_INTERVAL_MS,
  createDispatchRunReporter,
  type DispatchRunReporterDeps,
} from '../src/dispatchRunReporter.js';
import type { DispatchTarget } from '../src/dispatch.js';
import type { CommandResult, CommandRunner } from '../src/git.js';
import type {
  DispatchPrompt,
  DispatchRunEventInput,
  DispatchRunOpened,
  MotirClient,
} from '../src/client.js';

// A HARD-KILLED RUN STILL NAMES ITS BRANCH (Bug MOTIR-7329).
//
// `motir continue` reads a dead run's branch from its newest `checkout_ready`
// event. The reporter used to hold every event in process memory until a
// `close()` or an explicit `flush()` — and the single-card leg queues
// `checkout_ready` and then awaits the agent for the whole run. A SIGKILL, a lost
// sandbox or a dead laptop runs no handler, so the event never left the machine,
// the claim answered `no_branch`, and the checkpointed commits were stranded on a
// branch Motir could not name.
//
// So these tests never call `close()`: that is the whole point. "Killed" is
// modelled as an agent that has not returned yet — whatever reached the fake
// server by then is all a SIGKILL would leave behind.

interface Server {
  events: DispatchRunEventInput[];
  closes: number;
}

function fakeServer(): { client: DispatchRunReporterDeps['client']; server: Server } {
  const server: Server = { events: [], closes: 0 };
  const client: DispatchRunReporterDeps['client'] = {
    async openDispatchRun(args): Promise<DispatchRunOpened> {
      return { runId: 'run_1', created: true, status: 'running', seq: 0, cards: args.cards };
    },
    async appendDispatchRunEvents(args) {
      server.events.push(...args.events);
      return { runId: args.runId, appended: args.events.length, seq: server.events.length };
    },
    async closeDispatchRun() {
      server.closes += 1;
    },
    async heartbeatDispatchRun() {
      return 'ok' as const;
    },
  };
  return { client, server };
}

const OPEN = {
  projectKey: 'PROD',
  command: 'run' as const,
  runId: '20261002-120000',
  cards: [{ key: 'PROD-1', disposition: 'queued' as const }],
};

const ROOT = '/home/yue/work';
const BRANCH = 'subtask/PROD-1-the-card';

const primary = {
  cwd: `${ROOT}/motir-core`,
  reason: 'repo_checkout',
  targetRepo: 'motir-core',
  repoPath: `${ROOT}/motir-core`,
  verifyCheckoutAfterRun: false,
  cloneUrl: null,
} as DispatchTarget;

const git: CommandRunner = (): CommandResult => ({ exitCode: 0, stdout: '', stderr: '' });

/** Let every pending promise and I/O callback run — what the event loop does
 *  while the real agent process is working. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.useRealTimers();
});

describe('a leg whose agent never returns has already told the server its branch', () => {
  it('checkout_ready reaches the server before the agent finishes — with no close, ever', async () => {
    const { client, server } = fakeServer();
    const reporter = createDispatchRunReporter({ client });
    await reporter.open(OPEN);

    let seenWhileAgentRuns: DispatchRunEventInput[] = [];
    let releaseAgent: () => void = () => undefined;

    const leg = runDispatchLeg({
      client: {
        getWorkItem: async () => ({ item: { status: 'in_progress' } }) as never,
        listWorkItemDesigns: async () => ({ designs: [] }),
      } as unknown as Pick<MotirClient, 'getWorkItem' | 'listWorkItemDesigns'>,
      rootDir: ROOT,
      key: 'PROD-1',
      dispatch: {
        prompt: 'DO THE WORK',
        workflowMode: 'per_item_pr',
        branch: BRANCH,
        workBranch: BRANCH,
      } as unknown as DispatchPrompt,
      agent: { command: 'fake-agent', binary: 'fake-agent', args: [] },
      targets: [primary],
      primary,
      sessionBranch: null,
      onMaterialization: () => undefined,
      beforeSpawn: () => undefined,
      reporter,
      run: git,
      // The agent is WORKING: it has not exited, and on a SIGKILL it never will.
      runAgentFn: async () => {
        await settle();
        seenWhileAgentRuns = [...server.events];
        await new Promise<void>((resolve) => {
          releaseAgent = resolve;
        });
        return { exitCode: 0, signal: null, model: null };
      },
    });

    await vi.waitFor(() => expect(seenWhileAgentRuns.length).toBeGreaterThan(0));

    const ready = seenWhileAgentRuns.find((e) => e.kind === 'checkout_ready');
    // ⚠️ THE ASSERTION THE BUG FAILED: before MOTIR-7329 nothing at all had been
    // sent here, because the only flushes were `close()` and the between-card
    // flush of `auto` / the scope drain.
    expect(ready).toBeDefined();
    expect((ready!.data as { branch: string | null }).branch).toBe(BRANCH);
    expect(server.closes).toBe(0);

    // Let the leg finish so the test leaves nothing behind.
    releaseAgent();
    await leg;
  });

  it('run_opened is sent on enqueue too — the other event a dead run is read by', async () => {
    const { client, server } = fakeServer();
    const reporter = createDispatchRunReporter({ client });
    await reporter.open(OPEN);

    reporter.event({ kind: 'run_opened', data: { command: 'run', key: 'PROD-1' } });
    await settle();

    expect(server.events.map((e) => e.kind)).toEqual(['run_opened']);
  });

  it('an ordinary event still waits for a flush — a chatty agent is not one request per line', async () => {
    const { client, server } = fakeServer();
    const reporter = createDispatchRunReporter({ client });
    await reporter.open(OPEN);

    reporter.event({ kind: 'prompt_issued', workItemKey: 'PROD-1' });
    reporter.event({ kind: 'log', workItemKey: 'PROD-1' });
    await settle();

    expect(server.events).toEqual([]);
  });
});

describe('the heartbeat flushes the queue — a killed run loses at most one interval', () => {
  it('everything queued before a beat is on the server after it, with no close', async () => {
    vi.useFakeTimers();
    const { client, server } = fakeServer();
    const reporter = createDispatchRunReporter({ client });
    await reporter.open(OPEN);

    reporter.event({ kind: 'agent_started', workItemKey: 'PROD-1' });
    reporter.event({ kind: 'log', workItemKey: 'PROD-1' });
    expect(server.events).toEqual([]);

    await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS);

    expect(server.events.map((e) => e.kind)).toEqual(['agent_started', 'log']);
    expect(server.closes).toBe(0);
  });
});

describe('a background flush never lets the close overtake its events', () => {
  it('close waits for an in-flight send, so the server sees every event before the close', async () => {
    const order: string[] = [];
    let releaseAppend: () => void = () => undefined;
    const client: DispatchRunReporterDeps['client'] = {
      async openDispatchRun(args): Promise<DispatchRunOpened> {
        return { runId: 'run_1', created: true, status: 'running', seq: 0, cards: args.cards };
      },
      async appendDispatchRunEvents(args) {
        await new Promise<void>((resolve) => {
          releaseAppend = resolve;
        });
        order.push(...args.events.map((e) => e.kind));
        return { runId: args.runId, appended: args.events.length, seq: order.length };
      },
      async closeDispatchRun() {
        order.push('close');
      },
    };
    const reporter = createDispatchRunReporter({ client });
    await reporter.open(OPEN);

    // Starts a background send that is still in flight when the close arrives —
    // and the queue is EMPTY by then, which is the case a plain early return in
    // `flush()` would have let the close race past.
    reporter.event({ kind: 'checkout_ready', workItemKey: 'PROD-1', data: { branch: BRANCH } });
    await settle();
    const closing = reporter.close('completed');
    await settle();
    releaseAppend();
    await closing;

    expect(order).toEqual(['checkout_ready', 'close']);
  });
});
