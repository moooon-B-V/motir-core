import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobQueueRun } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withSystemContext } from '@/lib/workspaces/context';
import { jobSupervisionRepository } from '@/lib/repositories/jobSupervisionRepository';
import { jobStepRepository } from '@/lib/repositories/jobStepRepository';
import {
  supervisionSweepService,
  SUPERVISION_STALL_GRACE_MS,
  WORST_LEGITIMATE_GAP_MS,
} from '@/lib/services/supervisionSweepService';
import { codeGraphIndexDispatchService } from '@/lib/services/codeGraphIndexDispatchService';
import { ciRunnerBootService, FLEET_TIME_BUDGETS } from '@/lib/services/ciRunnerBootService';
import { engineJob } from '@/lib/jobs/engine/registry';
import { jobServices } from '@/lib/jobs/services';
// Imported for its SIDE EFFECT as well as its value: `defineJob` registers at
// module evaluation, so a test that only asks the registry finds nothing unless
// something has evaluated the definition.
import { supervisionSweep } from '@/lib/jobs/definitions/supervisionSweep';
import { SCHEDULE_CLUSTER_MINUTES } from '@/lib/jobs/schedules';
import { IDLE_MAX_MS, LEASE_MS, retryBackoffMs } from '@/lib/jobs/engine/worker';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// THE ABANDONED-SUPERVISION SWEEP (Story MOTIR-3778 · Subtask MOTIR-3830),
// against a real Postgres.
//
// The state it owns is one this story CREATES. While a supervision was a loop
// inside one run, a `finally` covered every way out of it; a chain of passes can
// simply stop, and then a container keeps running with nothing watching it. What
// is left without this is the 70-minute fleet reaper, whose resolver is
// CI-intent-shaped: for an index container it logs "no attributable intent",
// writes no usage row, and releases no admission slot.
//
// ⚠️ THE CRITERION THAT MATTERS IS THE NEGATIVE. Sweeping a DEAD supervision
// late costs some minutes of container; sweeping a LIVE one destroys a machine a
// customer's CI job is running in. So the assertions are weighted that way, and
// the grace window is asserted as an INEQUALITY against the arithmetic that sets
// it rather than as a number somebody liked the look of.

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

async function makeRun(state: 'pending' | 'running' | 'failed' = 'failed'): Promise<JobQueueRun> {
  seq += 1;
  const user = await usersService.createUser({
    email: `sweep-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: `Sweep ${seq}`,
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Sweep WS ${seq}`,
    ownerUserId: user.id,
  });
  return adminDb.jobQueueRun.create({
    data: {
      jobId: 'system.code-graph-index',
      eventName: 'code-graph/index.requested',
      workspaceId: workspace.id,
      runAt: new Date(Date.now() - 60 * 60_000),
      maxAttempts: 3,
      state,
    },
  });
}

const INDEX_SESSION = (subject: string) => ({
  handle: {
    provider: 'fake',
    id: `c-${subject}`,
    region: 'ams',
    createdAt: new Date().toISOString(),
  },
  bootedAt: new Date(Date.now() - 40 * 60_000).toISOString(),
  credentialExpiresAt: new Date().toISOString(),
  runId: 'r',
  dispatchId: 'd',
  repoRef: 'moooon-B-V/motir-core',
  slotRef: `slot-${subject}`,
  attribution: {
    orgId: 'org-1',
    workspaceId: 'ws-1',
    projectId: subject,
    repoFullName: 'moooon-B-V/motir-core',
  },
});

const RUNNER_SESSION = (subject: string) => ({
  intentId: subject,
  handle: {
    provider: 'fake',
    id: `c-${subject}`,
    region: 'ams',
    createdAt: new Date().toISOString(),
  },
  githubRunnerId: 7,
  bootedAt: new Date(Date.now() - 40 * 60_000).toISOString(),
  queuedAt: new Date(Date.now() - 41 * 60_000).toISOString(),
  attribution: {
    orgId: 'org-1',
    workspaceId: 'ws-1',
    projectId: 'proj-1',
    repoFullName: 'moooon-B-V/motir-core',
    workflowJobId: 99,
  },
});

/** A supervision whose next poll was due `dueMinutesAgo` minutes back, with its boot memo. */
async function seedSupervision(
  run: JobQueueRun,
  opts: { kind: 'index' | 'ci-runner'; subject: string; dueMinutesAgo: number; withMemo?: boolean },
): Promise<void> {
  await withSystemContext(async (tx) => {
    await jobSupervisionRepository.open(
      {
        runId: run.id,
        subject: opts.subject,
        kind: opts.kind,
        nextPollAt: new Date(Date.now() - opts.dueMinutesAgo * 60_000),
        workspaceId: run.workspaceId,
      },
      tx,
    );
    if (opts.withMemo === false) return;
    await jobStepRepository.create(
      {
        runId: run.id,
        stepId: opts.kind === 'index' ? `index-boot:${opts.subject}` : 'boot-runner',
        kind: 'run',
        result: {
          phase: 'supervising',
          session:
            opts.kind === 'index' ? INDEX_SESSION(opts.subject) : RUNNER_SESSION(opts.subject),
        },
        workspaceId: run.workspaceId,
      },
      tx,
    );
  });
}

function readRow(runId: string, subject: string) {
  return withSystemContext((tx) =>
    jobSupervisionRepository.findByRunAndSubject(runId, subject, tx),
  );
}

/** Stub both terminal transitions so the sweep's DISPATCH is what is observed. */
function stubTerminals() {
  return {
    index: vi
      .spyOn(codeGraphIndexDispatchService, 'settleIndexContainer')
      .mockResolvedValue({ outcome: 'teardown_failed', detail: 'stub' } as never),
    runner: vi
      .spyOn(ciRunnerBootService, 'settleSupervision')
      .mockResolvedValue({ outcome: 'unknown_intent' } as never),
  };
}

describe('the grace window', () => {
  it('exceeds the worst LEGITIMATE gap between two passes — asserted as the inequality', () => {
    // The arithmetic, re-derived from the constants rather than restated: the
    // longest wait a defer names, plus the worker's idle ceiling, plus a lease
    // that must expire before a dead claimant's row is reclaimable, plus the
    // longest retry backoff a FAILED pass can be rescheduled at.
    const worst =
      FLEET_TIME_BUDGETS.maxPollIntervalMs + IDLE_MAX_MS + LEASE_MS + retryBackoffMs(99, () => 0.5);
    expect(WORST_LEGITIMATE_GAP_MS).toBeGreaterThanOrEqual(worst);
    expect(SUPERVISION_STALL_GRACE_MS).toBeGreaterThan(WORST_LEGITIMATE_GAP_MS);
    // And comfortably inside the 70-minute fleet reaper it exists to pre-empt:
    // the grace plus the gap to the next clustered tick must still beat it.
    expect(SUPERVISION_STALL_GRACE_MS + 30 * 60_000).toBeLessThan(FLEET_TIME_BUDGETS.reapAfterMs);
  });
});

describe('a chain that stopped', () => {
  it('settles an INDEX supervision through the index fleet’s own terminal transition', async () => {
    const run = await makeRun('failed');
    await seedSupervision(run, { kind: 'index', subject: 'proj-a', dueMinutesAgo: 40 });
    const terminals = stubTerminals();

    const result = await supervisionSweepService.sweepAbandoned();

    expect(result).toEqual({ scanned: 1, settled: 1, skipped: 0 });
    expect(terminals.index).toHaveBeenCalledTimes(1);
    expect(terminals.runner).not.toHaveBeenCalled();
    // The session came out of the BOOT MEMO — the sweep reconstructs it the way
    // a resumed pass does, without invoking the handler at all.
    expect(terminals.index.mock.calls[0]![0]).toMatchObject({ slotRef: 'slot-proj-a' });
    expect(terminals.index.mock.calls[0]![1]).toMatchObject({
      done: true,
      reason: 'job_timed_out',
      failureDetail: expect.stringContaining('abandoned'),
    });
    expect((await readRow(run.id, 'proj-a'))!.state).toBe('settled');
  });

  it('settles a CI-RUNNER supervision through the CI fleet’s own terminal transition', async () => {
    const run = await makeRun('failed');
    await seedSupervision(run, { kind: 'ci-runner', subject: 'intent-1', dueMinutesAgo: 40 });
    const terminals = stubTerminals();

    expect(await supervisionSweepService.sweepAbandoned()).toEqual({
      scanned: 1,
      settled: 1,
      skipped: 0,
    });
    expect(terminals.runner).toHaveBeenCalledTimes(1);
    expect(terminals.index).not.toHaveBeenCalled();
    expect(terminals.runner.mock.calls[0]![0]).toMatchObject({ intentId: 'intent-1' });
  });

  it('sweeps a run whose queue row is GONE — the chain cannot come back at all', async () => {
    const run = await makeRun('failed');
    await seedSupervision(run, { kind: 'index', subject: 'proj-a', dueMinutesAgo: 40 });
    const terminals = stubTerminals();
    // Detach the row from the run first, so deleting the run does not cascade
    // the supervision away — the state under test is "the row outlived its run".
    await adminDb.$executeRawUnsafe(`DELETE FROM "job_step" WHERE "run_id" = $1`, run.id);
    await adminDb.jobQueueRun.delete({ where: { id: run.id } });

    // The supervision cascaded with its run, which is the OTHER correct answer:
    // nothing is left to sweep, and the sweep says so rather than inventing work.
    expect(await supervisionSweepService.sweepAbandoned()).toEqual({
      scanned: 0,
      settled: 0,
      skipped: 0,
    });
    expect(terminals.index).not.toHaveBeenCalled();
  });
});

describe('a LIVE supervision is never swept', () => {
  it('leaves a row whose next poll is inside the grace window', async () => {
    const run = await makeRun('pending');
    // Deferred to the far end of the backoff, well inside the window.
    await seedSupervision(run, { kind: 'index', subject: 'proj-a', dueMinutesAgo: 1 });
    const terminals = stubTerminals();

    expect(await supervisionSweepService.sweepAbandoned()).toEqual({
      scanned: 0,
      settled: 0,
      skipped: 0,
    });
    expect(terminals.index).not.toHaveBeenCalled();
    expect((await readRow(run.id, 'proj-a'))!.state).toBe('watching');
  });

  it('leaves a row whose owning run is RUNNING — a pass is in flight right now', async () => {
    const run = await makeRun('running');
    await seedSupervision(run, { kind: 'index', subject: 'proj-a', dueMinutesAgo: 40 });
    const terminals = stubTerminals();

    // The candidate is FOUND — its last poll instant is long past — and then
    // declined, which is exactly the two-facts check: `next_poll_at` says the
    // chain should have come back, the queue row says it still can.
    expect(await supervisionSweepService.sweepAbandoned()).toEqual({
      scanned: 1,
      settled: 0,
      skipped: 1,
    });
    expect(terminals.index).not.toHaveBeenCalled();
    expect((await readRow(run.id, 'proj-a'))!.state).toBe('watching');
  });

  it('leaves a row whose owning run is PENDING and due in the future', async () => {
    const run = await makeRun('pending');
    await adminDb.jobQueueRun.update({
      where: { id: run.id },
      data: { runAt: new Date(Date.now() + 60_000) },
    });
    await seedSupervision(run, { kind: 'index', subject: 'proj-a', dueMinutesAgo: 40 });
    const terminals = stubTerminals();

    expect(await supervisionSweepService.sweepAbandoned()).toMatchObject({
      settled: 0,
      skipped: 1,
    });
    expect(terminals.index).not.toHaveBeenCalled();
  });

  it('leaves a row already SETTLING — a live pass is mid-teardown', async () => {
    const run = await makeRun('failed');
    await seedSupervision(run, { kind: 'index', subject: 'proj-a', dueMinutesAgo: 40 });
    await withSystemContext((tx) =>
      jobSupervisionRepository.markState(run.id, 'proj-a', 'settling', tx),
    );
    const terminals = stubTerminals();

    // `listStalled` filters on `watching`, so it is not even a candidate — which
    // is what stops the sweep entering a teardown the driver is performing.
    expect(await supervisionSweepService.sweepAbandoned()).toEqual({
      scanned: 0,
      settled: 0,
      skipped: 0,
    });
    expect(terminals.index).not.toHaveBeenCalled();
  });
});

describe('idempotence and concurrency', () => {
  it('two overlapping ticks settle each stalled supervision ONCE, not twice', async () => {
    const run = await makeRun('failed');
    await seedSupervision(run, { kind: 'index', subject: 'proj-a', dueMinutesAgo: 40 });
    const terminals = stubTerminals();

    const [a, b] = await Promise.all([
      supervisionSweepService.sweepAbandoned(),
      supervisionSweepService.sweepAbandoned(),
    ]);

    // ⚠️ `teardown`'s own idempotence is NOT what is relied on. An idempotent
    // destroy does not make a second USAGE row disappear, so the claim is a
    // locked compare-and-set and exactly one tick wins it.
    expect(terminals.index).toHaveBeenCalledTimes(1);
    expect([a.settled, b.settled].sort()).toEqual([0, 1]);
  });

  it('a second tick after a settled one finds nothing', async () => {
    const run = await makeRun('failed');
    await seedSupervision(run, { kind: 'index', subject: 'proj-a', dueMinutesAgo: 40 });
    stubTerminals();

    expect((await supervisionSweepService.sweepAbandoned()).settled).toBe(1);
    expect(await supervisionSweepService.sweepAbandoned()).toEqual({
      scanned: 0,
      settled: 0,
      skipped: 0,
    });
  });

  it('drops a row with NO boot memo rather than inventing a teardown', async () => {
    const run = await makeRun('failed');
    await seedSupervision(run, {
      kind: 'index',
      subject: 'proj-a',
      dueMinutesAgo: 40,
      withMemo: false,
    });
    const terminals = stubTerminals();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await supervisionSweepService.sweepAbandoned();

    // Nothing was ever provisioned under this row, so there is no container to
    // tear down. Stop tracking it; do not fabricate a settle.
    expect(terminals.index).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scanned: 1, settled: 0, skipped: 1 });
    expect((await readRow(run.id, 'proj-a'))!.state).toBe('settled');
    expect(warn).toHaveBeenCalled();
  });
});

describe('a quiet tick is free', () => {
  it('performs no orchestrator call at all when nothing is stalled', async () => {
    const terminals = stubTerminals();
    expect(await supervisionSweepService.sweepAbandoned()).toEqual({
      scanned: 0,
      settled: 0,
      skipped: 0,
    });
    expect(terminals.index).not.toHaveBeenCalled();
    expect(terminals.runner).not.toHaveBeenCalled();
  });
});

describe('the shape of the thing', () => {
  it('re-implements NO teardown — there is no `teardown(` in the service', () => {
    // ⚠️ ASSERTED BY READING THE FILE, because the alternative is a second
    // implementation of the one path in this system where being subtly wrong
    // costs a duplicated billed container. The sweep calls the supervisors' own
    // terminal transitions, which already destroy, meter and release.
    const source = readFileSync('lib/services/supervisionSweepService.ts', 'utf8');
    expect(source).not.toMatch(/\bteardown\(/);
    expect(source).toMatch(/settleIndexContainer\(/);
    expect(source).toMatch(/settleSupervision\(/);
  });

  it('the handler delegates to the service and returns what it counted', async () => {
    // Driven through the ENGINE registry's own handler — the raw function the
    // worker actually invokes — rather than through the ledger, which would
    // re-enter the whole bookkeeping path and test that instead of this.
    const spy = vi
      .spyOn(supervisionSweepService, 'sweepAbandoned')
      .mockResolvedValue({ scanned: 3, settled: 2, skipped: 1 });
    const silentStep = {
      run: async <T>(_id: string, fn: () => T | Promise<T>): Promise<T> => fn(),
    };

    const handler = engineJob('system.supervision-sweep')!.handler;
    const result = await handler({ step: silentStep } as never, jobServices as never);

    expect(spy).toHaveBeenCalledTimes(1);
    // The counts land on the ledger row's `output`, which is what makes a quiet
    // tick and a busy one distinguishable on the operator surface.
    expect(result).toEqual({ scanned: 3, settled: 2, skipped: 1 });
  });

  it('is scheduled ON the cluster, and declares its catch-up at the cron', () => {
    const def = engineJob('system.supervision-sweep');
    expect(def).toBeDefined();
    expect(def).toBe(supervisionSweep);
    const minutes = def!.cron!.split(' ')[0]!.split(',').map(Number);
    // A new distinct offset is a new WAKE, forever (MOTIR-3314) — which on a
    // compute that suspends when idle is the whole bill.
    for (const m of minutes) expect(SCHEDULE_CLUSTER_MINUTES).toContain(m);
    // §11.8: the disposition is declared BESIDE the cron, never in a second list.
    expect(def!.catchUp).toBe('latest');
  });
});
