import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JobQueueRun } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { defineJob } from '@/lib/jobs/defineJob';
import { JobWorker } from '@/lib/jobs/engine/worker';
import { executeWithLedger } from '@/lib/jobs/engine/ledger';
import { JobStepYield } from '@/lib/jobs/engine/step';
import { deferRun, isJobRunDefer, JobRunDefer } from '@/lib/jobs/engine/defer';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// THE DEFER SIGNAL (Story MOTIR-3778 · Subtask MOTIR-3825), against a real
// Postgres.
//
// `docs/decisions/job-queue-foundation.md` §16.1 decides that a supervision
// hands ITSELF back — the same `job_queue` row, deferred forward — and the whole
// of the redesign after it stands on the three effects asserted here: the row
// goes back to `pending` at the named instant, the claim is released, and the
// attempt is REFUNDED.
//
// ⚠️ THE REFUND IS THE ONE WORTH THE DATABASE. `system.ci-runner-boot` runs
// `retryPolicy: 'none'` — a budget of exactly ONE — so a defer that spent an
// attempt would dead-letter a live CI supervision on its second poll, silently,
// on a path where the container is perfectly healthy. Asserting it here, over a
// hundred passes against the shipped `rescheduleAt`, is what makes that a
// property rather than a comment.

const silent = { info: () => {}, warn: () => {}, error: () => {} };

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
});

afterEach(async () => {
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

async function makeWorkspace(): Promise<string> {
  seq += 1;
  const user = await usersService.createUser({
    email: `defer-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: `Defer ${seq}`,
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Defer WS ${seq}`,
    ownerUserId: user.id,
  });
  return workspace.id;
}

async function enqueue(
  workspaceId: string,
  opts?: Partial<{ jobId: string; maxAttempts: number }>,
): Promise<string> {
  seq += 1;
  const row = await adminDb.jobQueueRun.create({
    data: {
      jobId: opts?.jobId ?? `defer.job.${seq}`,
      eventName: 'test.event',
      workspaceId,
      runAt: new Date(),
      maxAttempts: opts?.maxAttempts ?? 3,
    },
  });
  return row.id;
}

function readRun(id: string): Promise<JobQueueRun> {
  return adminDb.jobQueueRun.findUniqueOrThrow({ where: { id } });
}

/** Make the row due NOW, so the next `tick()` can claim it without waiting out a real interval. */
async function makeDue(id: string): Promise<void> {
  await adminDb.jobQueueRun.update({ where: { id }, data: { runAt: new Date() } });
}

describe('the signal itself', () => {
  it('`deferRun` throws a `JobRunDefer` carrying the instant and the reason', () => {
    const at = new Date(Date.now() + 15_000);
    try {
      deferRun(at, 'poll 4 of an index supervision');
      expect.unreachable('deferRun must never return');
    } catch (err) {
      expect(isJobRunDefer(err)).toBe(true);
      const defer = err as JobRunDefer;
      expect(defer.code).toBe('JOB_RUN_DEFER');
      expect(defer.resumeAt.getTime()).toBe(at.getTime());
      expect(defer.reason).toBe('poll 4 of an index supervision');
      // The message carries both, because it is what the worker logs.
      expect(defer.message).toContain(at.toISOString());
      expect(defer.message).toContain('poll 4 of an index supervision');
    }
  });

  it('REFUSES an invalid instant — a run deferred to `Invalid Date` is one nothing can claim', () => {
    expect(() => deferRun(new Date('not a date'), 'why')).toThrow(TypeError);
    // Not a `JobRunDefer`: a caller mistake must not look like a suspension, or
    // the worker would reschedule the row to NULL and lose it.
    try {
      deferRun(new Date(Number.NaN), 'why');
    } catch (err) {
      expect(isJobRunDefer(err)).toBe(false);
    }
    expect(() => deferRun('2026-01-01' as unknown as Date, 'why')).toThrow(TypeError);
  });

  it('accepts an instant in the PAST — that means "give it back at once", not an error', () => {
    const past = new Date(Date.now() - 60_000);
    try {
      deferRun(past, 'the interval already elapsed');
      expect.unreachable('deferRun must never return');
    } catch (err) {
      expect(isJobRunDefer(err)).toBe(true);
      expect((err as JobRunDefer).resumeAt.getTime()).toBe(past.getTime());
    }
  });

  it('`isJobRunDefer` narrows nothing else — a yield, an Error, a plain object', () => {
    expect(isJobRunDefer(new JobStepYield('wait:1', new Date()))).toBe(false);
    expect(isJobRunDefer(new Error('boom'))).toBe(false);
    expect(isJobRunDefer({ code: 'JOB_RUN_DEFER' })).toBe(false);
    expect(isJobRunDefer(null)).toBe(false);
    expect(isJobRunDefer(undefined)).toBe(false);
  });
});

describe('the worker settles a defer', () => {
  it('returns the row to `pending` at the named instant with the claim released', async () => {
    const ws = await makeWorkspace();
    const runId = await enqueue(ws);
    const resumeAt = new Date(Date.now() + 15_000);
    const outcomes: string[] = [];
    const w = new JobWorker({
      workerId: 'deferrer',
      logger: silent,
      onOutcome: (_run, outcome) => outcomes.push(outcome),
      execute: async () => deferRun(resumeAt, 'one poll done'),
    });

    await w.tick();
    await w.settled();

    const row = await readRun(runId);
    expect(row.state).toBe('pending');
    expect(row.runAt.getTime()).toBe(resumeAt.getTime());
    expect(row.claimedBy).toBeNull();
    expect(row.leaseExpiresAt).toBeNull();
    expect(row.lastError).toBeNull();
    expect(outcomes).toEqual(['deferred']);
  });

  it('REFUNDS the attempt — a `retryPolicy: none` run defers a hundred times and stays claimable', async () => {
    const ws = await makeWorkspace();
    // `maxAttempts: 1` is what `retryPolicy: 'none'` resolves to
    // (`lib/jobs/retries.ts`), and it is `system.ci-runner-boot`'s budget.
    const runId = await enqueue(ws, { maxAttempts: 1 });
    let passes = 0;
    let highWaterAttempts = 0;
    const w = new JobWorker({
      workerId: 'hundred-polls',
      logger: silent,
      execute: async (run) => {
        passes += 1;
        highWaterAttempts = Math.max(highWaterAttempts, run.attempts);
        deferRun(new Date(Date.now() + 60_000), `poll ${passes}`);
      },
    });

    for (let i = 0; i < 100; i += 1) {
      await makeDue(runId);
      expect(await w.tick()).toBe(1);
      await w.settled();
    }

    expect(passes).toBe(100);
    const row = await readRun(runId);
    // The claim spends one and the defer refunds it, so the row rests at 0 and
    // the claim never observed more than 1.
    expect(row.attempts).toBe(0);
    expect(highWaterAttempts).toBe(1);
    expect(row.state).toBe('pending');
    // Still claimable — which is the whole property, so assert it by CLAIMING.
    await makeDue(runId);
    expect(await w.tick()).toBe(1);
    await w.settled();
  });

  it('a defer and a yield take DIFFERENT arms, and neither swallows the other', async () => {
    const ws = await makeWorkspace();
    const deferring = await enqueue(ws, { jobId: 'defers.job' });
    const sleeping = await enqueue(ws, { jobId: 'sleeps.job' });
    const deferAt = new Date(Date.now() + 11_000);
    const wakeAt = new Date(Date.now() + 22_000);
    const outcomes: { jobId: string; outcome: string }[] = [];

    const w = new JobWorker({
      workerId: 'both-signals',
      logger: silent,
      timings: { claimBatch: 5 },
      onOutcome: (run, outcome) => outcomes.push({ jobId: run.jobId, outcome }),
      execute: async (run) => {
        if (run.jobId === 'defers.job') deferRun(deferAt, 'advanced one poll');
        throw new JobStepYield('supervise-wait:1', wakeAt);
      },
    });

    await w.tick();
    await w.settled();

    expect(outcomes.find((o) => o.jobId === 'defers.job')?.outcome).toBe('deferred');
    expect(outcomes.find((o) => o.jobId === 'sleeps.job')?.outcome).toBe('yielded');
    expect((await readRun(deferring)).runAt.getTime()).toBe(deferAt.getTime());
    expect((await readRun(sleeping)).runAt.getTime()).toBe(wakeAt.getTime());
    // Neither is a failure: both refund, and neither records an error.
    for (const id of [deferring, sleeping]) {
      const row = await readRun(id);
      expect(row.attempts).toBe(0);
      expect(row.lastError).toBeNull();
      expect(row.state).toBe('pending');
    }
  });

  it('a defer writes NO step row — the handler owns its own state, the ledger remembers nothing', async () => {
    const ws = await makeWorkspace();
    const runId = await enqueue(ws);
    const w = new JobWorker({
      workerId: 'stateless',
      logger: silent,
      execute: async () => deferRun(new Date(Date.now() + 5_000), 'nothing checkpointed'),
    });

    await w.tick();
    await w.settled();

    // A `step.sleep` would have left a `sleep` checkpoint here; a defer is
    // deliberately not a checkpoint at all (`lib/jobs/engine/defer.ts`).
    expect(await adminDb.jobStep.count({ where: { runId } })).toBe(0);
  });

  it('a defer during a DRAIN strands nothing — the row leaves `inFlight` and the release finds none of it', async () => {
    const ws = await makeWorkspace();
    const runId = await enqueue(ws);
    const w = new JobWorker({
      workerId: 'draining-deferrer',
      logger: silent,
      execute: async () => deferRun(new Date(Date.now() + 30_000), 'mid-drain'),
    });

    await w.tick();
    await w.settled();
    await w.shutdown();

    const row = await readRun(runId);
    expect(w.inFlightCount).toBe(0);
    // The acceptance property the drain already carries: no row is left
    // `running` with no live claimant.
    expect(row.state).toBe('pending');
    expect(row.claimedBy).toBeNull();
    expect(
      await adminDb.jobQueueRun.count({
        where: { state: 'running', claimedBy: 'draining-deferrer' },
      }),
    ).toBe(0);
  });
});

describe('the ledger across a deferred run', () => {
  it('N defers then a success leave ONE `job_run` row, `succeeded`, and no dead letter', async () => {
    seq += 1;
    const jobId = `defer.ledger.${seq}`;
    let pass = 0;
    // Three defers, then a fourth pass that finishes — the shape a supervision
    // has, at the smallest size that can show the row count is not per-pass.
    defineJob({ id: jobId as never, retryPolicy: 'transient' }, () => {
      pass += 1;
      if (pass <= 3) deferRun(new Date(Date.now() + 1_000), `poll ${pass}`);
      return { polls: pass };
    });

    const workspaceId = await makeWorkspace();
    const event = await adminDb.jobEvent.create({
      data: { name: jobId, data: { workspaceId }, workspaceId },
    });
    const created = await adminDb.jobQueueRun.create({
      data: {
        jobId,
        eventId: event.id,
        eventName: jobId,
        workspaceId,
        runAt: new Date(),
        maxAttempts: 3,
      },
    });

    for (let i = 0; i < 4; i += 1) {
      const row = await readRun(created.id);
      if (i < 3) {
        await expect(executeWithLedger(row, { workspaceId })).rejects.toSatisfy(isJobRunDefer);
      } else {
        await expect(executeWithLedger(row, { workspaceId })).resolves.toEqual({ polls: 4 });
      }
    }

    const runs = await adminDb.jobRun.findMany({ where: { functionId: jobId } });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('succeeded');
    expect(runs[0]!.output).toEqual({ polls: 4 });
    expect(await adminDb.jobRunDlq.count({ where: { functionId: jobId } })).toBe(0);
    // The start row is memoized, so the four passes cost ONE `job-run:start`
    // step and one `job-run:succeeded` — not four of each.
    const steps = await adminDb.jobStep.findMany({ where: { runId: created.id } });
    expect(steps.map((s) => s.stepId).sort()).toEqual(['job-run:start', 'job-run:succeeded']);
  });
});
