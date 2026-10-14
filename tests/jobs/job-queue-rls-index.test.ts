import type { Prisma } from '@/generated/prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { jobQueueRepository } from '@/lib/repositories/jobQueueRepository';
import { adminDb } from '../helpers/adminDb';
import { truncateJobRuns } from '../helpers/db';

// The worker's hot queue queries stay index scans under FORCE RLS (bug MOTIR-8519).
//
// `job_queue` is FORCE ROW LEVEL SECURITY and the runtime role (`motir_app`) does not
// bypass it, so its policy is a security barrier. Postgres only drives an index scan
// with a qual behind that barrier when the qual is LEAKPROOF — and `state = 'pending'`
// (enum equality) is not. Production therefore full-scanned ~268k terminal rows on
// every claim, backlog read and lease reclaim. The fix is a pair of PARTIAL indexes
// whose `WHERE` the planner proves rather than evaluates; this file is what fails if
// they are dropped, renamed onto a column list Prisma pairs away, or a query is
// rewritten into a shape they no longer serve.
//
// HOW IT MEASURES. It calls the REAL repository methods — no copied SQL to drift —
// inside one transaction as `motir_app` with the system context bound, then reads
// `pg_stat_xact_user_tables`, which counts THIS transaction's scans. A full scan of
// `job_queue` shows as `seq_scan > 0`. Parallel workers are switched off for the
// transaction so every scan is counted in this backend; the seq-vs-index choice the
// test is about does not depend on parallelism.
//
// ⚠️ THE TABLE MUST BE LARGE AND ANALYZED. On a near-empty table a sequential scan is
// the planner's correct choice and nothing could tell the two plans apart. So the
// fixture is mostly TERMINAL rows — the population retention never removes — and
// ANALYZE runs before the measurement, as autovacuum would in production.

const TERMINAL_ROWS = 100_000;

beforeEach(async () => {
  await truncateJobRuns();
});

afterEach(async () => {
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Seed the production shape: a large terminal population, a few live rows. */
async function seedQueue(): Promise<void> {
  // Owner role: a fixture writes rows the runtime role's policy is about, and
  // ANALYZE needs ownership.
  await adminDb.$executeRawUnsafe(`
    INSERT INTO "job_queue"
      ("id", "job_id", "event_name", "run_at", "max_attempts", "state", "created_at", "updated_at")
    SELECT 'mq-done-' || g, 'test.terminal', 'test/terminal',
           (now() AT TIME ZONE 'UTC') - make_interval(mins => g),
           3, (CASE WHEN g % 50 = 0 THEN 'failed' ELSE 'succeeded' END)::"job_run_state",
           (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')
      FROM generate_series(1, ${TERMINAL_ROWS}) AS g
  `);
  await adminDb.$executeRawUnsafe(`
    INSERT INTO "job_queue"
      ("id", "job_id", "event_name", "run_at", "max_attempts", "state", "created_at", "updated_at")
    SELECT 'mq-due-' || g, 'test.due', 'test/due',
           (now() AT TIME ZONE 'UTC') - interval '1 minute',
           3, 'pending', (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')
      FROM generate_series(1, 3) AS g
  `);
  await adminDb.$executeRawUnsafe(`
    INSERT INTO "job_queue"
      ("id", "job_id", "event_name", "run_at", "max_attempts", "state", "claimed_by",
       "lease_expires_at", "attempts", "created_at", "updated_at")
    SELECT 'mq-lapsed-' || g, 'test.lapsed', 'test/lapsed',
           (now() AT TIME ZONE 'UTC') - interval '1 hour', 3, 'running', 'dead-worker',
           (now() AT TIME ZONE 'UTC') - interval '1 minute', 1,
           (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')
      FROM generate_series(1, 2) AS g
  `);
  await adminDb.$executeRawUnsafe('ANALYZE "job_queue"');
}

interface ScanCounts {
  seqScans: number;
  idxScans: number;
}

/**
 * Run `fn` as the runtime role with the system context bound — exactly the binding
 * the worker's queue calls run under — and return its result with this
 * transaction's scan counts on `job_queue`.
 */
async function measuredAsRuntimeRole<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<{ result: T; scans: ScanCounts }> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.system_admin', 'true', true)`;
    await tx.$executeRawUnsafe('SET LOCAL max_parallel_workers_per_gather = 0');
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    const result = await fn(tx);
    const rows = await tx.$queryRaw<Array<{ seqScans: number; idxScans: number }>>`
      SELECT coalesce("seq_scan", 0)::int AS "seqScans",
             coalesce("idx_scan", 0)::int AS "idxScans"
        FROM pg_stat_xact_user_tables
       WHERE "relname" = 'job_queue'
    `;
    return { result, scans: rows[0] ?? { seqScans: 0, idxScans: 0 } };
  });
}

describe('job_queue under FORCE RLS — the worker never full-scans the table (MOTIR-8519)', () => {
  it('the CLAIM reads the due rows through an index, not the terminal population', async () => {
    await seedQueue();

    const { result, scans } = await measuredAsRuntimeRole((tx) =>
      jobQueueRepository.claimDueRuns('worker-8519', 10, 60_000, tx),
    );

    expect(result.map((r) => r.id).sort()).toEqual(['mq-due-1', 'mq-due-2', 'mq-due-3']);
    expect(scans.seqScans).toBe(0);
    expect(scans.idxScans).toBeGreaterThan(0);
  });

  it('the BACKLOG read counts the due rows through an index', async () => {
    await seedQueue();

    const { result, scans } = await measuredAsRuntimeRole((tx) =>
      jobQueueRepository.readDueBacklog(tx),
    );

    expect(result.depth).toBe(3);
    expect(scans.seqScans).toBe(0);
    expect(scans.idxScans).toBeGreaterThan(0);
  });

  it('the LEASE RECLAIM finds the lapsed runs through an index', async () => {
    await seedQueue();

    const { result, scans } = await measuredAsRuntimeRole((tx) =>
      jobQueueRepository.reclaimExpiredLeases(tx),
    );

    expect(result).toBe(2);
    expect(scans.seqScans).toBe(0);
    expect(scans.idxScans).toBeGreaterThan(0);
  });

  it('the LEASE RENEWAL — every heartbeat — touches only the running rows through an index', async () => {
    await seedQueue();

    const { result, scans } = await measuredAsRuntimeRole((tx) =>
      jobQueueRepository.renewLeases('dead-worker', 60_000, tx),
    );

    expect(result).toBe(2);
    expect(scans.seqScans).toBe(0);
    expect(scans.idxScans).toBeGreaterThan(0);
  });

  it('the DEBOUNCE lookup on enqueue finds its pending row through an index', async () => {
    await seedQueue();
    await adminDb.$executeRawUnsafe(
      `UPDATE "job_queue" SET "debounce_key" = 'k-8519' WHERE "id" = 'mq-due-1'`,
    );

    const { result, scans } = await measuredAsRuntimeRole((tx) =>
      jobQueueRepository.findPendingDebouncedForUpdate('test.due', 'k-8519', tx),
    );

    expect(result?.id).toBe('mq-due-1');
    expect(scans.seqScans).toBe(0);
    expect(scans.idxScans).toBeGreaterThan(0);
  });
});
