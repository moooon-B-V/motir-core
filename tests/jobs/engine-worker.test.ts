import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JobQueueRun } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withSystemContext } from '@/lib/workspaces/context';
import { jobQueueRepository } from '@/lib/repositories/jobQueueRepository';
import { JobWorker, retryBackoffMs, serializeWorkerFailure } from '@/lib/jobs/engine/worker';
import { JobStepYield } from '@/lib/jobs/engine/step';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobEngine } from '../helpers/db';

// The WORKER (Story MOTIR-3414 · Subtask MOTIR-3421), against a real Postgres.
//
// ⚠️ THE CONCURRENCY CASE IS THE POINT OF THIS FILE, AND A SERIAL TEST CANNOT
// SEE IT. Claiming is a read-derived write; two sequential claims never collide,
// so a test that claims twice in a row passes against an implementation with no
// lock at all. The `two workers` block below therefore drives GENUINE
// concurrency — `Promise.all` over two workers against one warm pool — and
// accepts every legitimate interleaving (any split of the rows) while asserting
// the one thing that must never happen: a row executed twice.

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobEngine();
});

afterEach(async () => {
  await truncateJobEngine();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

async function makeWorkspace(): Promise<string> {
  seq += 1;
  const user = await usersService.createUser({
    email: `worker-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: `Worker ${seq}`,
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Worker WS ${seq}`,
    ownerUserId: user.id,
  });
  return workspace.id;
}

async function enqueue(
  workspaceId: string,
  opts?: Partial<{ jobId: string; runAt: Date; maxAttempts: number; attempts: number }>,
): Promise<string> {
  seq += 1;
  const row = await adminDb.jobQueueRun.create({
    data: {
      jobId: opts?.jobId ?? `test.job.${seq}`,
      eventName: 'test.event',
      workspaceId,
      runAt: opts?.runAt ?? new Date(),
      maxAttempts: opts?.maxAttempts ?? 3,
      attempts: opts?.attempts ?? 0,
    },
  });
  return row.id;
}

/** Read a run's current row as the owner — "what actually happened", not "what the app could see". */
async function readRun(id: string): Promise<JobQueueRun> {
  return adminDb.jobQueueRun.findUniqueOrThrow({ where: { id } });
}

const silent = { info: () => {}, warn: () => {}, error: () => {} };

describe('the claim — two workers, one queue', () => {
  it('NEVER executes the same run twice under genuine concurrency', async () => {
    const ws = await makeWorkspace();
    const ids = [];
    for (let i = 0; i < 20; i++) ids.push(await enqueue(ws));

    // Every execution, by whichever worker. If the claim were a plain
    // read-then-write, a row would appear twice here.
    const executions: string[] = [];
    const make = (name: string) =>
      new JobWorker({
        workerId: name,
        logger: silent,
        timings: { claimBatch: 4 },
        execute: async (run) => {
          executions.push(run.id);
          // A real handler does I/O; the await widens the window in which a
          // second worker could claim the same row, which is what we want.
          await new Promise((r) => setTimeout(r, 5));
        },
      });

    const a = make('worker-a');
    const b = make('worker-b');

    // Drive both until the queue is drained, concurrently — the warm-pool race.
    for (let round = 0; round < 12; round++) {
      const [ca, cb] = await Promise.all([a.tick(), b.tick()]);
      if (ca === 0 && cb === 0) break;
    }

    // THE assertion: every run executed EXACTLY once.
    expect(executions).toHaveLength(new Set(executions).size);
    expect(new Set(executions)).toEqual(new Set(ids));

    // Every legitimate SPLIT is accepted — we assert nothing about which worker
    // got which row, only that between them they got each row once. (An
    // assertion like "each worker took ten" would be a real race condition in
    // the test, since `SKIP LOCKED` makes the split timing-dependent by design.)
    const states = await adminDb.jobQueueRun.findMany({ where: { id: { in: ids } } });
    expect(states.every((s) => s.state === 'succeeded')).toBe(true);
  });

  it('claims OLDEST-DUE first', async () => {
    const ws = await makeWorkspace();
    const t = Date.now();
    const third = await enqueue(ws, { runAt: new Date(t - 1_000) });
    const first = await enqueue(ws, { runAt: new Date(t - 3_000) });
    const second = await enqueue(ws, { runAt: new Date(t - 2_000) });

    const order: string[] = [];
    const w = new JobWorker({
      workerId: 'ordering',
      logger: silent,
      timings: { claimBatch: 1 },
      execute: async (run) => {
        order.push(run.id);
      },
    });
    await w.tick();
    await w.tick();
    await w.tick();

    expect(order).toEqual([first, second, third]);
  });

  it('does NOT claim a run whose run_at is in the future', async () => {
    const ws = await makeWorkspace();
    const later = await enqueue(ws, { runAt: new Date(Date.now() + 60_000) });
    const executed: string[] = [];
    const w = new JobWorker({
      workerId: 'future',
      logger: silent,
      execute: async (run) => {
        executed.push(run.id);
      },
    });

    expect(await w.tick()).toBe(0);
    expect(executed).toEqual([]);
    expect((await readRun(later)).state).toBe('pending');
  });
});

describe('the lease — a worker that dies', () => {
  it('a run whose lease EXPIRED is reclaimed by another worker', async () => {
    const ws = await makeWorkspace();
    const runId = await enqueue(ws);

    // Worker A claims and then "dies" — modelled by never settling the run and
    // never renewing its lease, which is exactly what a SIGKILLed process leaves
    // behind: a `running` row with a lease that stops being renewed.
    const dead = new JobWorker({
      workerId: 'dead-worker',
      logger: silent,
      timings: { leaseMs: 50 },
      execute: async () => {
        /* claimed, then the process vanishes */
      },
    });
    await withSystemContext((tx) => jobQueueRepository.claimDueRuns('dead-worker', 1, 50, tx));
    expect((await readRun(runId)).state).toBe('running');
    expect((await readRun(runId)).claimedBy).toBe('dead-worker');
    expect((await readRun(runId)).attempts).toBe(1);
    void dead;

    await new Promise((r) => setTimeout(r, 120)); // the lease expires

    const executed: string[] = [];
    const live = new JobWorker({
      workerId: 'live-worker',
      logger: silent,
      execute: async (run) => {
        executed.push(run.id);
      },
    });
    // `tick` reclaims expired leases BEFORE claiming, so the abandoned run is
    // picked up in the same tick rather than waiting for the next one.
    expect(await live.tick()).toBe(1);
    expect(executed).toEqual([runId]);
    expect((await readRun(runId)).state).toBe('succeeded');
  });

  it('REFUNDS the attempt a dead worker spent — a crash must not eat the retry budget', async () => {
    const ws = await makeWorkspace();
    const runId = await enqueue(ws, { maxAttempts: 3 });

    await withSystemContext((tx) => jobQueueRepository.claimDueRuns('crasher', 1, 40, tx));
    expect((await readRun(runId)).attempts).toBe(1);

    await new Promise((r) => setTimeout(r, 100));
    await withSystemContext((tx) => jobQueueRepository.reclaimExpiredLeases(tx));

    // The handler never ran and never failed, so the attempt was not spent on
    // anything. Without the refund a rolling deploy catching the same long run
    // three times would dead-letter it with no error to show an operator.
    const after = await readRun(runId);
    expect(after.attempts).toBe(0);
    expect(after.state).toBe('pending');
    expect(after.claimedBy).toBeNull();
  });

  it('a LIVE worker keeps its claim — renewal is what tells it apart from a dead one', async () => {
    const ws = await makeWorkspace();
    const runId = await enqueue(ws);

    await withSystemContext((tx) => jobQueueRepository.claimDueRuns('long-runner', 1, 60, tx));
    await new Promise((r) => setTimeout(r, 40));
    // The heartbeat, which is the only signal distinguishing a run that is
    // taking a long time from a worker that has died. Nothing about duration
    // alone could.
    await withSystemContext((tx) => jobQueueRepository.renewLeases('long-runner', 5_000, tx));
    await new Promise((r) => setTimeout(r, 60));

    const reclaimed = await withSystemContext((tx) => jobQueueRepository.reclaimExpiredLeases(tx));
    expect(reclaimed).toBe(0);
    const still = await readRun(runId);
    expect(still.state).toBe('running');
    expect(still.claimedBy).toBe('long-runner');
  });

  it('renewal is scoped to the OWNER — one worker cannot extend another’s lease', async () => {
    const ws = await makeWorkspace();
    await enqueue(ws);
    await withSystemContext((tx) => jobQueueRepository.claimDueRuns('owner', 1, 5_000, tx));

    const renewed = await withSystemContext((tx) =>
      jobQueueRepository.renewLeases('someone-else', 60_000, tx),
    );
    expect(renewed).toBe(0);
  });
});

describe('failure, retry and the durable yield', () => {
  it('a failing run is RESCHEDULED with backoff until the budget is spent, then FAILS', async () => {
    const ws = await makeWorkspace();
    const runId = await enqueue(ws, { maxAttempts: 2 });
    const outcomes: string[] = [];
    const w = new JobWorker({
      workerId: 'failing',
      logger: silent,
      onOutcome: (_run, outcome) => outcomes.push(outcome),
      execute: async () => {
        throw new Error('handler exploded');
      },
    });

    await w.tick();
    let row = await readRun(runId);
    expect(row.state).toBe('pending'); // retrying
    expect(row.attempts).toBe(1);
    expect(row.runAt.getTime()).toBeGreaterThan(Date.now()); // backed off
    expect(row.lastError).toMatchObject({ message: 'handler exploded' });

    // Make it due again and spend the last attempt.
    await adminDb.jobQueueRun.update({ where: { id: runId }, data: { runAt: new Date() } });
    await w.tick();
    row = await readRun(runId);
    expect(row.state).toBe('failed');
    expect(row.attempts).toBe(2);
    expect(row.claimedBy).toBeNull();
    expect(outcomes).toEqual(['retrying', 'failed']);
  });

  it('a JobStepYield is NOT a failure — it reschedules at the deadline and REFUNDS the attempt', async () => {
    const ws = await makeWorkspace();
    const runId = await enqueue(ws, { maxAttempts: 3 });
    const resumeAt = new Date(Date.now() + 30 * 60_000);
    const outcomes: string[] = [];
    const w = new JobWorker({
      workerId: 'sleeper',
      logger: silent,
      onOutcome: (_run, outcome) => outcomes.push(outcome),
      execute: async () => {
        throw new JobStepYield('supervise-wait:1', resumeAt);
      },
    });

    await w.tick();
    const row = await readRun(runId);
    expect(row.state).toBe('pending');
    expect(row.runAt.getTime()).toBe(resumeAt.getTime());
    // A half-hour supervisor that slept sixty times must not have consumed
    // sixty attempts — sleeping is not failing.
    expect(row.attempts).toBe(0);
    expect(row.claimedBy).toBeNull();
    expect(outcomes).toEqual(['yielded']);
  });

  it('one run failing does not stop its BATCH-MATES from settling', async () => {
    const ws = await makeWorkspace();
    const bad = await enqueue(ws, { jobId: 'bad.job' });
    const good = await enqueue(ws, { jobId: 'good.job' });
    const w = new JobWorker({
      workerId: 'mixed',
      logger: silent,
      timings: { claimBatch: 5 },
      execute: async (run) => {
        if (run.jobId === 'bad.job') throw new Error('nope');
      },
    });

    await w.tick();
    expect((await readRun(good)).state).toBe('succeeded');
    expect((await readRun(bad)).state).toBe('pending'); // retrying
  });
});

describe('graceful shutdown', () => {
  it('SIGTERM drains: NO run is left `running` with no live claimant', async () => {
    const ws = await makeWorkspace();
    const ids = [await enqueue(ws), await enqueue(ws), await enqueue(ws)];

    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const w = new JobWorker({
      workerId: 'draining',
      logger: silent,
      timings: { claimBatch: 5, drainTimeoutMs: 3_000 },
      execute: async () => {
        await held; // in flight, and staying that way until we let go
      },
    });

    const ticking = w.tick();
    // Wait until the claim has actually landed rather than sleeping a guessed
    // interval — the authoritative signal is the row state, not the clock.
    for (let i = 0; i < 100 && w.inFlightCount === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(w.inFlightCount).toBe(3);

    const shutting = w.shutdown();
    release();
    await ticking;
    await shutting;

    // THE acceptance criterion. A `running` row with no live claimant is work
    // nobody will ever pick up, which is the state a drain exists to prevent.
    const rows = await adminDb.jobQueueRun.findMany({ where: { id: { in: ids } } });
    expect(rows.filter((r) => r.state === 'running')).toEqual([]);
    expect(rows.every((r) => r.claimedBy === null)).toBe(true);
  });

  it('a drain that TIMES OUT still releases — an unfinished run is re-runnable, an orphan is not', async () => {
    const ws = await makeWorkspace();
    const runId = await enqueue(ws);

    let release!: () => void;
    const never = new Promise<void>((r) => {
      release = r;
    });
    const w = new JobWorker({
      workerId: 'stuck',
      logger: silent,
      // A deliberately tiny drain window: Fly SIGKILLs some seconds after
      // SIGTERM, so the release has to happen whether or not the run finished.
      timings: { drainTimeoutMs: 100 },
      execute: async () => {
        await never;
      },
    });

    const ticking = w.tick();
    for (let i = 0; i < 100 && w.inFlightCount === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await w.shutdown();

    // Released despite still executing. Safe precisely because the step ledger
    // memoized whatever it completed — the next claimant resumes rather than
    // restarts. That is MOTIR-3422 paying for itself outside its own card.
    const row = await readRun(runId);
    expect(row.state).toBe('pending');
    expect(row.claimedBy).toBeNull();

    release();
    await ticking;
  });

  it('a drained worker CLAIMS NOTHING MORE', async () => {
    const ws = await makeWorkspace();
    await enqueue(ws);
    const w = new JobWorker({ workerId: 'stopped', logger: silent, execute: async () => {} });
    await w.shutdown();
    expect(await w.tick()).toBe(0);
  });
});

describe('waking up promptly', () => {
  it('notify() cuts an idle sleep short, so a fresh event does not wait out the poll', async () => {
    const ws = await makeWorkspace();
    const executed: string[] = [];
    const w = new JobWorker({
      workerId: 'notified',
      logger: silent,
      // A poll ceiling far longer than this test is willing to wait: if the
      // notify path did not work, the assertion below could only pass by
      // waiting 30 s.
      timings: { idleMinMs: 30_000, idleMaxMs: 30_000 },
      execute: async (run) => {
        executed.push(run.id);
      },
    });

    w.start();
    // Let the loop reach its idle sleep (the queue is empty).
    for (let i = 0; i < 100 && executed.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
      if (i === 20) break;
    }

    const started = Date.now();
    const runId = await enqueue(ws);
    w.notify();

    for (let i = 0; i < 300 && executed.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const elapsed = Date.now() - started;

    await w.shutdown();
    expect(executed).toEqual([runId]);
    // Well inside the 30 s poll interval it would otherwise have waited out.
    expect(elapsed).toBeLessThan(10_000);
  });
});

describe('retryBackoffMs', () => {
  it('doubles from one second and caps at five minutes', () => {
    const noJitter = () => 0.5; // jitter term becomes exactly 0
    expect(retryBackoffMs(1, noJitter)).toBe(1_000);
    expect(retryBackoffMs(2, noJitter)).toBe(2_000);
    expect(retryBackoffMs(3, noJitter)).toBe(4_000);
    expect(retryBackoffMs(10, noJitter)).toBe(300_000);
    expect(retryBackoffMs(50, noJitter)).toBe(300_000);
  });

  it('JITTERS by ±20%, so a common-cause cohort does not retry in lockstep', () => {
    // Without jitter, every run of a job that failed for one reason (a provider
    // outage) retries at the same instant and hits the recovering dependency as
    // a single wave. The spread is the point, so the test asserts a spread.
    const values = new Set<number>();
    for (let i = 0; i < 200; i++) values.add(retryBackoffMs(3));
    expect(values.size).toBeGreaterThan(50);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(3_200);
      expect(v).toBeLessThanOrEqual(4_800);
    }
  });

  it('never returns a negative delay', () => {
    expect(retryBackoffMs(1, () => 0)).toBeGreaterThanOrEqual(0);
    expect(retryBackoffMs(0, () => 0)).toBeGreaterThanOrEqual(0);
  });
});

describe('serializeWorkerFailure', () => {
  it('keeps the message and stack of an Error', () => {
    const e = new Error('kaboom');
    const s = serializeWorkerFailure(e);
    expect(s.message).toBe('kaboom');
    expect(s.stack).toContain('kaboom');
  });

  it('stringifies a non-Error throw rather than losing it', () => {
    expect(serializeWorkerFailure('just a string')).toEqual({ message: 'just a string' });
    expect(serializeWorkerFailure(42)).toEqual({ message: '42' });
  });
});
