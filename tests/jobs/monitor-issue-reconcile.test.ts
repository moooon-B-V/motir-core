import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  MONITOR_CONNECTION_POLL_MAX_ATTEMPTS,
  MONITOR_ISSUE_RECONCILE_CRON,
  MONITOR_ISSUE_RECONCILE_OVERDUE_MS,
  monitorConnectionPoll,
  monitorIssueReconcileTick,
} from '@/lib/jobs/definitions/monitorIssueReconcile';
import type { JobQueueRun } from '@/generated/prisma/client';
import { executeWithLedger, recordEngineTerminalFailure } from '@/lib/jobs/engine/ledger';
import { JobWorker } from '@/lib/jobs/engine/worker';
import { jobDefinitions } from '@/lib/jobs/registry';
import { sendEvent } from '@/lib/jobs/sendEvent';
import {
  fakeMonitorProvider,
  fakeMonitorState,
  resetFakeMonitorProvider,
} from '@/lib/monitors/providers/fake';
import { sentryMonitorProvider } from '@/lib/monitors/providers/sentry';
import { registerMonitorProvider } from '@/lib/monitors/registry';
import { monitorConnectionService } from '@/lib/services/monitorConnectionService';
import { monitorIngestionService } from '@/lib/services/monitorIngestionService';
import { withSystemContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { JobTestEngine } from '../helpers/jobs';
import { makeWorkItemFixture } from '../fixtures';

// THE SCHEDULED RECONCILER (Story MOTIR-4929 · Subtask MOTIR-5581) — the
// half-hourly tick, its per-connection fan-out, and the terminal failure written
// onto the connection before it dead-letters.
//
// The fan-out is asserted through the engine's REAL dispatcher (the queue rows it
// writes, and the idempotency constraint that collapses a retried tick), and the
// terminal failure through the REAL worker + ledger settle path
// (`executeWithLedger`) — the same wiring `event-cutover-story-gate.test.ts`
// drives, so "dead-letters" means a `job_run_dlq` row the engine itself wrote.

const POLL_JOB = 'monitor/connection.poll-requested';
const silent = { info: () => {}, warn: () => {}, error: () => {} };

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  resetFakeMonitorProvider();
  fakeMonitorState().issues = [];
  registerMonitorProvider(fakeMonitorProvider, 'sentry');
});

afterEach(async () => {
  registerMonitorProvider(sentryMonitorProvider, 'sentry');
  vi.restoreAllMocks();
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

/** A project with a grant and `count` bindings, made through the real services. */
async function seedConnections(count: number): Promise<{ ids: string[]; workspaceId: string }> {
  const n = seq++;
  const fx = await makeWorkItemFixture({ name: `Tick ${n}`, identifier: `TCK${n}` });
  await monitorConnectionService.completeGrant(
    {
      provider: 'sentry',
      providerInstallationId: `pi-tick-${n}`,
      code: 'valid-code',
      projectId: fx.projectId,
    },
    fx.ctx,
  );
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const dto = await monitorConnectionService.bindProject(
      fx.projectId,
      { externalProjectId: `ext-${n}-${i}`, externalProjectSlug: `p${i}` },
      fx.ctx,
    );
    ids.push(dto.id);
  }
  return { ids, workspaceId: fx.workspaceId };
}

const queuedPolls = () => adminDb.jobQueueRun.findMany({ where: { jobId: POLL_JOB } });

async function payloadFor(run: JobQueueRun): Promise<unknown> {
  const eventId = run.eventId;
  if (eventId === null) return {};
  const event = await withSystemContext((tx) => tx.jobEvent.findUnique({ where: { id: eventId } }));
  return event?.data ?? {};
}

/** A worker wired EXACTLY as `scripts/worker.ts` wires the production one: the
 *  ledger around each attempt, and the after-all-retries hook that writes the
 *  `failed` row and the dead-letter row. */
function realWorker(id: string): JobWorker {
  return new JobWorker({
    workerId: id,
    logger: silent,
    execute: async (run) => {
      await executeWithLedger(run, await payloadFor(run));
    },
    onTerminalFailure: async (run, error) =>
      recordEngineTerminalFailure(run, error, await payloadFor(run)),
  });
}

/** Tick the worker until every poll run has left `pending`/`running`, making
 *  backed-off retries due immediately so the budget is spent in the test. */
async function drainPolls(worker: JobWorker): Promise<void> {
  for (let pass = 0; pass < MONITOR_CONNECTION_POLL_MAX_ATTEMPTS * 4; pass += 1) {
    await adminDb.jobQueueRun.updateMany({
      where: { jobId: POLL_JOB, state: 'pending' },
      data: { runAt: new Date(Date.now() - 1_000) },
    });
    await worker.tick();
    await worker.settled();
    const open = await adminDb.jobQueueRun.count({
      where: { jobId: POLL_JOB, state: { in: ['pending', 'running'] } },
    });
    if (open === 0) return;
  }
  throw new Error('poll runs did not settle');
}

async function enqueuePoll(connectionId: string, workspaceId: string, key: string) {
  await sendEvent(POLL_JOB, { workspaceId, connectionId, idempotencyKey: key }, { strict: true });
}

const connectionRow = (id: string) =>
  adminDb.monitorConnection.findUniqueOrThrow({ where: { id } });

describe('the schedule', () => {
  it('runs ON the cluster, every half hour, and is registered with its fan-out', () => {
    expect(MONITOR_ISSUE_RECONCILE_CRON).toBe('0,30 * * * *');
    expect(monitorIssueReconcileTick.cron).toBe(MONITOR_ISSUE_RECONCILE_CRON);
    expect(jobDefinitions).toContain(monitorIssueReconcileTick);
    expect(jobDefinitions).toContain(monitorConnectionPoll);
    // Two missed ticks — what the room calls a stalled scheduler.
    expect(MONITOR_ISSUE_RECONCILE_OVERDUE_MS).toBe(60 * 60 * 1000);
  });
});

describe('the TICK fans out one run per binding', () => {
  it('emits exactly three poll runs for three connections, each with its own key — and a re-run of the SAME tick adds none', async () => {
    const { ids } = await seedConnections(3);
    const tick = new JobTestEngine({ function: monitorIssueReconcileTick });

    const first = await tick.execute();
    expect(first.error).toBeUndefined();
    expect(first.result).toEqual({ dispatched: 3 });

    const runs = await queuedPolls();
    expect(runs).toHaveLength(3);
    const keys = runs.map((r) => r.idempotencyKey);
    expect(new Set(keys).size).toBe(3);
    for (const id of ids) expect(keys.some((k) => k?.startsWith(`${id}:`))).toBe(true);

    // The same tick RUN again (a retry keeps its run id): the dispatcher's
    // idempotency constraint collapses every event onto the run already queued.
    await tick.execute();
    expect(await queuedPolls()).toHaveLength(3);
  });

  it('dispatches nothing when nothing is bound', async () => {
    const outcome = await new JobTestEngine({ function: monitorIssueReconcileTick }).execute();
    expect(outcome.result).toEqual({ dispatched: 0 });
    expect(await queuedPolls()).toHaveLength(0);
  });
});

describe('the per-connection run, through the REAL settle path', () => {
  it('a poll that throws on EVERY attempt ends with the failure ON the connection AND a dead-letter row', async () => {
    const { ids, workspaceId } = await seedConnections(1);
    const [connectionId] = ids as [string];
    vi.spyOn(monitorIngestionService, 'pollConnection').mockRejectedValue(
      new Error('the provider host is unreachable'),
    );
    await enqueuePoll(connectionId, workspaceId, `${connectionId}:tick-a`);

    await drainPolls(realWorker('terminal'));

    const [run] = await queuedPolls();
    expect(run).toMatchObject({ state: 'failed', attempts: MONITOR_CONNECTION_POLL_MAX_ATTEMPTS });
    const row = await connectionRow(connectionId);
    expect(row.lastPollStatus).toBe('failed');
    expect(row.lastPollError).toContain('the provider host is unreachable');
    // …and the engine STILL dead-lettered it: the write is in addition to the
    // existing path, never instead of it.
    expect(await adminDb.jobRunDlq.count({ where: { functionId: POLL_JOB } })).toBe(1);
  });

  it('a poll that throws ONCE and then succeeds leaves the connection ok, with no failure written', async () => {
    const { ids, workspaceId } = await seedConnections(1);
    const [connectionId] = ids as [string];
    const real = monitorIngestionService.pollConnection.bind(monitorIngestionService);
    let calls = 0;
    vi.spyOn(monitorIngestionService, 'pollConnection').mockImplementation(async (id) => {
      calls += 1;
      if (calls === 1) throw new Error('a blip');
      return real(id);
    });
    await enqueuePoll(connectionId, workspaceId, `${connectionId}:tick-b`);

    await drainPolls(realWorker('recovers'));

    const [run] = await queuedPolls();
    expect(run!.state).toBe('succeeded');
    const row = await connectionRow(connectionId);
    expect(row.lastPollStatus).toBe('ok');
    expect(row.lastPollError).toBeNull();
    expect(await adminDb.jobRunDlq.count({ where: { functionId: POLL_JOB } })).toBe(0);
  });

  it('two connections, one failing terminally: the other still completes ok', async () => {
    const { ids, workspaceId } = await seedConnections(2);
    const [broken, healthy] = ids as [string, string];
    const real = monitorIngestionService.pollConnection.bind(monitorIngestionService);
    vi.spyOn(monitorIngestionService, 'pollConnection').mockImplementation(async (id) => {
      if (id === broken) throw new Error('only this one is broken');
      return real(id);
    });
    await enqueuePoll(broken, workspaceId, `${broken}:tick-c`);
    await enqueuePoll(healthy, workspaceId, `${healthy}:tick-c`);

    await drainPolls(realWorker('isolated'));

    expect((await connectionRow(broken)).lastPollStatus).toBe('failed');
    expect((await connectionRow(healthy)).lastPollStatus).toBe('ok');
    const states = Object.fromEntries(
      (await queuedPolls()).map((r) => [r.idempotencyKey?.split(':')[0], r.state]),
    );
    expect(states).toEqual({ [broken]: 'failed', [healthy]: 'succeeded' });
  });
});

describe('no job reaches the PROBE', () => {
  it('no file under lib/jobs/definitions references probeHealth', () => {
    const dir = join(process.cwd(), 'lib', 'jobs', 'definitions');
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => readFileSync(join(dir, f), 'utf8').includes('probeHealth'));
    expect(offenders).toEqual([]);
  });
});
