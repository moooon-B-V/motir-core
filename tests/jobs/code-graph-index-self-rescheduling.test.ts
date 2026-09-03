import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobQueueRun } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { withSystemContext } from '@/lib/workspaces/context';
import { jobSupervisionRepository } from '@/lib/repositories/jobSupervisionRepository';
import {
  codeGraphIndexDispatchService,
  INDEX_ADMISSION_BUDGETS,
  INDEX_FLEET_TIME_BUDGETS,
  indexPollWaitMs,
  type IndexDispatchInput,
} from '@/lib/services/codeGraphIndexDispatchService';
import { codeGraphIndexAdmissionService } from '@/lib/services/codeGraphIndexAdmissionService';
import { fakeOrchestrator } from '@motir/orchestrator';
import { isJobRunDefer, type JobRunDefer } from '@/lib/jobs/engine/defer';
import { inProcessMemoSteps } from '@/lib/jobs/supervision/inProcessSteps';
import { JobWorker } from '@/lib/jobs/engine/worker';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import {
  INDEX_REPO_REF,
  resetTarballBodyTrap,
  seedIndexWorkspace,
  stubIndexFleet,
} from '../helpers/indexFleet';

// A SUPERVISION IS A SELF-RESCHEDULING RUN (Story MOTIR-3778 · Subtask
// MOTIR-3828), against a real Postgres and the real `job_supervision` table.
//
// ⚠️ THIS FILE DRIVES THE DURABLE STORE, WHICH IS WHAT MAKES IT DIFFERENT FROM
// EVERY OTHER INDEX SUITE. `tests/jobs/code-graph-index.test.ts` and
// `tests/ciFleet/codeGraphIndexDispatch.test.ts` both run a supervision to
// COMPLETION — one through `JobTestEngine`'s pass loop, one through the
// in-process wrapper — because what they assert is the ledger contract and the
// dispatch outcomes, neither of which is about how a pass ends. Here the passes
// ARE the subject: one `describe` each, the row `pending` between them, the boot
// memoized across them, and teardown reachable from three transitions and never
// from a defer.
//
// The world is the shared index-fleet fixture on the `fake` orchestrator, with a
// REAL `job_queue` row underneath — the supervision row FKs to it, so a
// synthetic run id would not do.

const FAST = {
  bootDeadlineMs: 60_000,
  indexTimeoutMs: 600_000,
  pollIntervalMs: 1,
  maxPollIntervalMs: 2,
  admissionWaitMs: 1,
  maxAdmissionWaitMs: 2,
} as const;

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await adminDb.fleetInFlightSlot.deleteMany({});
  _resetInstallationTokenCache();
  fakeOrchestrator.reset();
  resetTarballBodyTrap();
  stubIndexFleet();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await adminDb.fleetInFlightSlot.deleteMany({});
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

interface Fixture {
  run: JobQueueRun;
  input: IndexDispatchInput;
  projectIds: string[];
  workspaceId: string;
}

async function seed(projectCount = 1): Promise<Fixture> {
  seq += 1;
  const slug = `sr${seq}`;
  const { workspaceId, projectIds, installationId } = await seedIndexWorkspace(slug, projectCount);
  const run = await adminDb.jobQueueRun.create({
    data: {
      jobId: 'system.code-graph-index',
      eventName: 'code-graph/index.requested',
      workspaceId,
      runAt: new Date(),
      maxAttempts: 3,
    },
  });
  const [repoOwner, repoName] = INDEX_REPO_REF.split('/') as [string, string];
  return {
    run,
    projectIds,
    workspaceId,
    input: {
      installationId,
      providerId: 'github',
      organizationId: 'org-fixture',
      workspaceId,
      projectId: projectIds[0]!,
      repoOwner,
      repoName,
      repoRef: INDEX_REPO_REF,
      defaultBranch: 'main',
      runId: run.id,
      dispatchId: `evt-${slug}`,
    },
  };
}

/** Count the provider reads and the provisions the way a bill would. */
function countOrchestrator(): { describes: () => number; provisions: () => number } {
  const describe_ = vi.spyOn(fakeOrchestrator, 'describe');
  const provision = vi.spyOn(fakeOrchestrator, 'provision');
  return {
    describes: () => describe_.mock.calls.length,
    provisions: () => provision.mock.calls.length,
  };
}

/**
 * One PASS, with a step seam whose memo persists across passes — which is what
 * `job_step` is to the real engine. Returns the defer it threw, or the outcome
 * it settled with.
 */
function passer(input: IndexDispatchInput, overrides: Record<string, unknown> = {}) {
  const steps = inProcessMemoSteps({
    run: async <T>(_id: string, fn: () => T | Promise<T>): Promise<T> => fn(),
  });
  return async (): Promise<{ defer: JobRunDefer } | { outcome: unknown }> => {
    try {
      const outcome = await codeGraphIndexDispatchService.advanceIndexContainer(
        input.runId,
        input,
        { ...FAST, ...overrides, steps },
      );
      return { outcome };
    } catch (err) {
      if (isJobRunDefer(err)) return { defer: err };
      throw err;
    }
  };
}

function readRow(runId: string, subject: string) {
  return withSystemContext((tx) =>
    jobSupervisionRepository.findByRunAndSubject(runId, subject, tx),
  );
}

describe('one pass, one provider read', () => {
  it('performs EXACTLY ONE `describe` per pass, and the total stays LINEAR in the poll count', async () => {
    const fx = await seed();
    const counts = countOrchestrator();
    const pass = passer(fx.input);

    // Pass 1: admit + boot, and the opening wait. NO provider read — the
    // container cannot have started in the instant `provision` returned, which
    // is why both loops this replaces sleep before their first poll.
    const first = await pass();
    expect('defer' in first).toBe(true);
    expect(counts.describes()).toBe(0);
    expect(counts.provisions()).toBe(1);

    // Then ten polls, one per pass, with nothing else touching the provider.
    for (let n = 1; n <= 10; n += 1) {
      const before = counts.describes();
      const result = await pass();
      expect('defer' in result, `pass ${n} must defer`).toBe(true);
      expect(counts.describes() - before, `pass ${n} performs one describe`).toBe(1);
      expect(counts.provisions(), 'and provisions nothing further').toBe(1);
    }

    // ⚠️ THE FIGURE THIS SHAPE EXISTS TO BEAT. MOTIR-3763 measured the falsified
    // `step.sleep` yield at N(N+1)/2 — 7 503 orchestrator reads for the ~122
    // polls of a thirty-minute index, against 122 for the in-process loop. The
    // property to hold is LINEARITY, and this is it: reads == polls.
    expect(counts.describes()).toBe(10);
    expect((await readRow(fx.run.id, fx.projectIds[0]!))!.pollNumber).toBe(10);
  });

  it('leaves the supervision row `watching` and the wait at the SHIPPED cadence between passes', async () => {
    const fx = await seed();
    // The real budgets this time — the wait a pass is owed is the card's, and
    // §16.6 forbids this change moving it.
    const pass = passer(fx.input, { pollIntervalMs: undefined, maxPollIntervalMs: undefined });
    const first = await pass();
    expect('defer' in first && first.defer.resumeAt).toBeTruthy();

    const row = await readRow(fx.run.id, fx.projectIds[0]!);
    expect(row!.state).toBe('watching');
    expect(row!.pollNumber).toBe(0);
    // The opening wait is `indexPollWaitMs(1)` — the same call the old loop made
    // as the first statement of its `for` body.
    const opening = 'defer' in first ? first.defer.resumeAt.getTime() - Date.now() : 0;
    expect(opening).toBeGreaterThan(indexPollWaitMs(1) - 2_000);
    expect(opening).toBeLessThanOrEqual(indexPollWaitMs(1));
  });
});

describe('the worker frees its slot between passes', () => {
  it('a deferred pass returns the `job_queue` row to `pending`, unclaimed, and out of the in-flight set', async () => {
    const fx = await seed();
    const pass = passer(fx.input);

    const worker = new JobWorker({
      workerId: 'index-supervisor',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      // The engine's own settle path, driven over a real claim — what the
      // handler throws is what the worker has to interpret.
      execute: async () => {
        const result = await pass();
        if ('defer' in result) throw result.defer;
      },
    });

    expect(await worker.tick()).toBe(1);
    await worker.settled();

    const row = await adminDb.jobQueueRun.findUniqueOrThrow({ where: { id: fx.run.id } });
    expect(row.state).toBe('pending');
    expect(row.claimedBy).toBeNull();
    expect(row.leaseExpiresAt).toBeNull();
    // Between polls the supervision occupies NO worker capacity — which is the
    // whole of what this story is for.
    expect(worker.inFlightCount).toBe(0);
    expect(worker.freeCapacity).toBe(10);
  });
});

describe('a restart mid-supervision', () => {
  it('re-attaches to the SAME container and provisions no second one', async () => {
    const fx = await seed();
    const counts = countOrchestrator();

    // Two independent step seams — a fresh memo each, as a restarted worker
    // would have — but ONE shared persistent memo underneath, which is what
    // `job_step` is. Modelled as the same `passer` re-created around a memo that
    // survives, because the boot's memo is exactly what buys re-attachment.
    const shared = new Map<string, unknown>();
    const persistentSteps = {
      run: async <T>(id: string, fn: () => T | Promise<T>): Promise<T> => {
        if (shared.has(id)) return shared.get(id) as T;
        const value = await fn();
        shared.set(id, value);
        return value;
      },
    };
    const onePass = async (): Promise<boolean> => {
      try {
        await codeGraphIndexDispatchService.advanceIndexContainer(fx.input.runId, fx.input, {
          ...FAST,
          steps: persistentSteps,
        });
        return false;
      } catch (err) {
        if (isJobRunDefer(err)) return true;
        throw err;
      }
    };

    for (let i = 0; i < 6; i += 1) expect(await onePass()).toBe(true);

    // ⚠️ ONE provision across six passes. The boot replays from the memo, the
    // session comes back with it, and the loop re-attaches to the container it
    // already has — the property §13.2 records, preserved rather than
    // reimplemented.
    expect(counts.provisions()).toBe(1);
    expect(fakeOrchestrator.liveContainerIds()).toHaveLength(1);
  });
});

describe('the fan-out is a cursor, not a loop', () => {
  it('asks for the SECOND project’s admission only after the first has settled', async () => {
    const fx = await seed(2);
    const admit = vi.spyOn(codeGraphIndexAdmissionService, 'admit');
    const subjects = () =>
      new Set(admit.mock.calls.map((c) => (c[0] as { projectId: string }).projectId));

    const steps = inProcessMemoSteps({
      run: async <T>(_id: string, fn: () => T | Promise<T>): Promise<T> => fn(),
    });
    const runFleetPass = async (): Promise<boolean> => {
      // The JOB's own fan-out: one `advanceIndexContainer` per project, in
      // order, aborted by the first defer.
      try {
        for (const projectId of fx.projectIds) {
          await codeGraphIndexDispatchService.advanceIndexContainer(
            fx.run.id,
            { ...fx.input, projectId },
            { ...FAST, steps },
          );
        }
        return false;
      } catch (err) {
        if (isJobRunDefer(err)) return true;
        throw err;
      }
    };

    // A few passes in: only the FIRST project has been admitted. The second's
    // container is not booted beside it — the sequencing the old `for` body had,
    // now expressed across runs.
    for (let i = 0; i < 3; i += 1) expect(await runFleetPass()).toBe(true);
    expect(subjects()).toEqual(new Set([fx.projectIds[0]]));
    expect(fakeOrchestrator.liveContainerIds()).toHaveLength(1);

    // Settle the first, then keep passing: the second is admitted, and the first
    // REPLAYS — no further provider read for it.
    for (const id of fakeOrchestrator.liveContainerIds())
      fakeOrchestrator.completeJob(id, { exitCode: 0 });
    for (let i = 0; i < 3; i += 1) await runFleetPass();

    expect(subjects()).toEqual(new Set(fx.projectIds));
    expect((await readRow(fx.run.id, fx.projectIds[0]!))!.state).toBe('settled');
    expect((await readRow(fx.run.id, fx.projectIds[1]!))!.state).toBe('watching');
  });
});

describe('teardown is a terminal transition', () => {
  it('is NOT reached on a defer — the negative §15.4 measured', async () => {
    const fx = await seed();
    const settle = vi.spyOn(codeGraphIndexDispatchService, 'settleIndexContainer');
    const pass = passer(fx.input);

    for (let i = 0; i < 5; i += 1) expect('defer' in (await pass())).toBe(true);

    // A `finally` around the old loop would have called this on the FIRST
    // suspension and destroyed the container it was watching.
    expect(settle).not.toHaveBeenCalled();
    expect(fakeOrchestrator.liveContainerIds()).toHaveLength(1);
  });

  it('is reached on the `done` verdict', async () => {
    const fx = await seed();
    const settle = vi.spyOn(codeGraphIndexDispatchService, 'settleIndexContainer');
    const pass = passer(fx.input);

    await pass();
    for (const id of fakeOrchestrator.liveContainerIds())
      fakeOrchestrator.completeJob(id, { exitCode: 0 });
    const result = await pass();

    expect('outcome' in result).toBe(true);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ outcome: { outcome: 'settled', verdict: { indexed: true } } });
    expect((await readRow(fx.run.id, fx.projectIds[0]!))!.state).toBe('settled');
  });

  it('is reached on the DEADLINE, measured from the memoized `bootedAt`', async () => {
    const fx = await seed();
    const settle = vi.spyOn(codeGraphIndexDispatchService, 'settleIndexContainer');
    // A timeout shorter than the opening wait, so the SECOND pass meets it
    // before it polls — the resumed-pass case §13.3(a) is about.
    const pass = passer(fx.input, { indexTimeoutMs: 1 });

    await pass();
    const result = await pass();

    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0]![1]).toMatchObject({
      reason: 'job_timed_out',
      failureDetail: expect.stringContaining('deadline'),
    });
    expect('outcome' in result).toBe(true);
  });

  it('is reached on a THROW from inside the poll, and the error still propagates', async () => {
    const fx = await seed();
    const settle = vi.spyOn(codeGraphIndexDispatchService, 'settleIndexContainer');
    const pass = passer(fx.input);
    await pass();

    const boom = new Error('the provider went away');
    vi.spyOn(codeGraphIndexDispatchService, 'pollIndexContainer').mockRejectedValueOnce(boom);

    await expect(pass()).rejects.toBe(boom);
    // Settled FIRST, then the throw — the arm a step reachable only from the
    // loop's two normal exits could never cover (§13.4).
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0]![1]).toMatchObject({
      failureDetail: expect.stringContaining('a poll threw'),
    });
  });

  it('is reached on the POLL CEILING, which is a TOTAL bound across passes', async () => {
    const fx = await seed();
    const settle = vi.spyOn(codeGraphIndexDispatchService, 'settleIndexContainer');
    const pass = passer(fx.input, { maxPollIterations: 3 });

    await pass(); // the opening wait
    for (let i = 0; i < 3; i += 1) expect('defer' in (await pass())).toBe(true);
    const result = await pass();

    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0]![1]).toMatchObject({
      failureDetail: 'supervision hit the 3-poll ceiling',
    });
    expect('outcome' in result).toBe(true);
  });
});

describe('what this change may not move', () => {
  it('leaves every fleet budget byte-identical', () => {
    // §16.6: the wait changes WHERE it is spent, never how long it is. A
    // literal, because a number is what a reader checks.
    expect(INDEX_FLEET_TIME_BUDGETS).toEqual({
      bootDeadlineMs: 120_000,
      indexTimeoutMs: 1_800_000,
      pollIntervalMs: 3_000,
      maxPollIntervalMs: 15_000,
      maxPollIterations: 500,
      maxConsecutiveReadFailures: 3,
    });
    expect(INDEX_ADMISSION_BUDGETS).toEqual({
      maxAttempts: 60,
      baseWaitMs: 5_000,
      maxWaitMs: 60_000,
    });
    // And the backoff itself: the first four waits of an index, unchanged.
    expect([1, 2, 3, 4].map((n) => indexPollWaitMs(n))).toEqual([3_000, 6_000, 12_000, 15_000]);
  });

  it('keeps the whole admission backoff inside ONE memoized step (§13.3(c))', async () => {
    const fx = await seed();
    const admit = vi.spyOn(codeGraphIndexAdmissionService, 'admit');
    const pass = passer(fx.input);

    for (let i = 0; i < 5; i += 1) await pass();

    // Five passes, one admission. Converting the backoff to a defer loop would
    // re-ask — and a resume that re-asked AFTER the settle released the slot
    // would be granted a fresh one and never release it. §16.6 decides that it
    // stays where it is.
    expect(admit).toHaveBeenCalledTimes(1);
  });
});
