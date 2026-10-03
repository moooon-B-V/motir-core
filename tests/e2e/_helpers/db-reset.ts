// Playwright-side DB reset.
//
// Re-uses tests/helpers/db.ts's truncateAuthTables via the same Prisma
// client used everywhere else. A thin wrapper rather than a direct
// import-and-call so Playwright callers always go through this module —
// if the reset surface needs to grow (e.g. seed data, clear outbox file)
// we extend here without touching the Vitest helper.
// Load the job registry in THIS process — see the file for why the emit path
// cannot do it itself here.
import './job-registry';
import { rmSync } from 'node:fs';
import { db } from '@/lib/db';
import { adminDb } from '@/tests/helpers/adminDb';
import { truncateAuthTables, truncateJobRuns, type ResetExecutor } from '@/tests/helpers/db';

const EMAIL_OUTBOX_PATH = process.env['EMAIL_OUTBOX_PATH'] ?? '/tmp/motir-test-emails.jsonl';

/**
 * How long one TRUNCATE may WAIT for its locks before giving up its place in the
 * queue (MOTIR-7415). Short against the 30 s Playwright hook budget, and far
 * shorter than the worker's 5 s interactive-transaction timeout, so a worker
 * statement queued behind a blocked truncate is released before its own
 * transaction expires.
 */
const TRUNCATE_LOCK_TIMEOUT = '2s';

/**
 * Runs a truncating reset in its own transaction under `SET LOCAL lock_timeout`,
 * with a bounded retry on Postgres deadlock (40P01) AND lock timeout (55P03).
 *
 * ⚠️ THIS IS THE E2E LANE'S ONLY DOOR ONTO A TRUNCATE, AND IT IS EXPORTED FOR
 * THAT REASON (MOTIR-3739). The retry used to live inside `resetDatabase`'s own
 * closure, so the protection reached exactly one call and the reset block above
 * it read as uniformly guarded — five specs then hand-rolled a raw
 * `TRUNCATE "job_event", "job_queue", "job_step"` beside it with none of it, and
 * one of them deadlocked against the lane's live job worker and reddened an
 * unrelated pull request. `tests/e2e-truncate-retry.test.ts` is what keeps the
 * next hand-rolled truncate from re-inventing the failure.
 *
 * WHY A RETRY IS THE RIGHT TRADE HERE, and only here. The lane deliberately runs
 * a REAL job worker beside the specs: it claims rows out of `job_queue` with
 * `FOR UPDATE SKIP LOCKED` and writes the ledger continuously, while a TRUNCATE
 * wants `AccessExclusiveLock` on the same relations in an order Postgres chooses.
 * That collision is transient — the run finishes within moments — so a bounded
 * retry converts it into a wait. It is a MASK, not a cure: MOTIR-3066 traced the
 * vitest lane's `40P01` to an abandoned `Promise.all` arm holding a transaction
 * open, and was explicit that agreeing on a truncate order cannot fix the class.
 * A live worker running beside a truncating test is this lane's intended shape,
 * which is what makes the mask acceptable in it.
 *
 * ⚠️ WHY THE LOCK TIMEOUT, AND WHY A DEADLOCK RETRY ALONE WAS NOT ENOUGH
 * (MOTIR-7415). A TRUNCATE that has to WAIT raises nothing: it sits in the lock
 * queue, and an `AccessExclusiveLock` request at the head of that queue makes
 * every later request on the same tables queue behind it — including the
 * worker's lease-renewal UPDATE, which does not conflict with whatever the
 * truncate is waiting for. When Playwright's 30 s hook budget then runs out the
 * statement is NOT cancelled (an abandoned promise cancels nothing), so it stays
 * queued, the next test's `beforeEach` queues a second one behind it, and the
 * worker stalled for ~100 s on motir-core#3369's merge group. Measured against a
 * real Postgres: an idle transaction holding an ordinary read lock on
 * `job_queue` stalled a worker-shaped `UPDATE job_queue` for 11.1 s behind an
 * unbounded truncate, and for 1.5 s behind one under a 2 s `lock_timeout`. So a
 * blocked truncate now gives up its place after `TRUNCATE_LOCK_TIMEOUT`, logs
 * who holds the locks, and tries again.
 *
 * The budget: 5 attempts × 2 s plus 0.5 + 1 + 1.5 + 2 s of backoff is 15 s at
 * worst, inside the 30 s hook, so the LAST attempt fails with its own error
 * rather than Playwright's timeout — the only failure that carries the reason.
 */
export async function withTruncateDeadlockRetry<T>(
  truncate: (executor: ResetExecutor) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await adminDb.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${TRUNCATE_LOCK_TIMEOUT}'`);
          return truncate(tx);
        },
        // The interactive transaction's own clock must not be what fires: the
        // truncate waits at most `TRUNCATE_LOCK_TIMEOUT` for locks, and the
        // statement itself can be slow on a loaded runner.
        { maxWait: 10_000, timeout: 20_000 },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      const deadlock = /40P01|deadlock/i.test(message);
      const lockTimeout = /55P03|lock timeout/i.test(message);
      if (lockTimeout) await logLockHolders(attempt);
      if ((!deadlock && !lockTimeout) || attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

/**
 * Prints every other session holding or awaiting a lock on a table in this
 * database, with its transaction age and last statement — the holder that put
 * a truncate in the queue is the one thing the CI log has never named
 * (MOTIR-7415). Diagnostic only: a failure here must not mask the truncate's.
 */
async function logLockHolders(attempt: number): Promise<void> {
  try {
    const rows = await adminDb.$queryRaw<Record<string, unknown>[]>`
      SELECT a.pid, a.application_name, a.state, a.wait_event_type, a.wait_event,
             round(extract(epoch FROM now() - a.xact_start))::int AS xact_age_s,
             round(extract(epoch FROM now() - a.state_change))::int AS state_age_s,
             pg_blocking_pids(a.pid) AS blocked_by,
             string_agg(DISTINCT c.relname || ':' || l.mode ||
               CASE WHEN l.granted THEN '' ELSE ' (waiting)' END, ', ') AS locks,
             left(a.query, 200) AS last_query
        FROM pg_locks l
        JOIN pg_class c ON c.oid = l.relation
        JOIN pg_stat_activity a ON a.pid = l.pid
       WHERE l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
         AND a.pid <> pg_backend_pid()
         AND c.relkind = 'r'
       GROUP BY a.pid, a.application_name, a.state, a.wait_event_type, a.wait_event,
                a.xact_start, a.state_change, a.query
       ORDER BY a.xact_start NULLS LAST
       LIMIT 20`;
    console.warn(
      `[e2e-truncate] lock timeout (${TRUNCATE_LOCK_TIMEOUT}) on attempt ${attempt}; ` +
        `sessions holding or awaiting table locks:\n${JSON.stringify(rows, null, 2)}`,
    );
  } catch (err) {
    console.warn(`[e2e-truncate] lock timeout on attempt ${attempt}; lock dump failed:`, err);
  }
}

/**
 * Truncates the auth-related tables (user, account, session, verification)
 * AND clears the file outbox the dev server writes reset links to. Both
 * must be reset together — leaving the outbox alone would let a previous
 * test's reset link leak into the next test's `waitForEmail` call.
 *
 * Safe to call from a Playwright `test.beforeEach`. Idempotent.
 *
 * Retries on Postgres deadlock (40P01) and lock timeout (55P03) — see
 * `withTruncateDeadlockRetry` for the second. The PREVIOUS test can leave jobs still
 * querying through the dev server (e.g. the 5.1 mention fan-out trailing the
 * comments journey), and TRUNCATE deadlocking against those in-flight
 * transactions is a transient ordering collision, not a test failure — the job
 * finishes within moments and the retry succeeds.
 */
export async function resetDatabase(): Promise<void> {
  await withTruncateDeadlockRetry(truncateAuthTables);
  rmSync(EMAIL_OUTBOX_PATH, { force: true });
}

/**
 * Clears the job rows a `TRUNCATE "workspace" CASCADE` never reaches — the five
 * engine/ledger tables plus `email_delivery`, all of them untenanted
 * (`tests/helpers/db.ts`'s `truncateJobRuns`) — under the retry above.
 *
 * ⚠️ CALL THIS RATHER THAN `truncateJobRuns` DIRECTLY, and never add a second
 * raw TRUNCATE beside it. Five specs used to pair the helper with a hand-rolled
 * `TRUNCATE "job_event", "job_queue", "job_step" RESTART IDENTITY CASCADE` — a
 * strict SUBSET of what the helper had truncated on the line above, so it
 * cleared nothing the helper had not already cleared, and it was the statement
 * that deadlocked (MOTIR-3739).
 */
export async function truncateJobTables(): Promise<void> {
  await withTruncateDeadlockRetry(truncateJobRuns);
}

/**
 * Re-export the Prisma client so specs can assert post-conditions on
 * the database without importing @/lib/db directly. Keeps "what
 * Playwright touches in the DB layer" discoverable in one file.
 *
 * ⚠️ THIS IS THE CODE UNDER TEST'S CONNECTION, AND A SPEC ALMOST NEVER WANTS IT
 * FOR SEEDING (MOTIR-2939). Under `motir_app` — which MOTIR-2734 makes the
 * suite's only connection — an unbound statement against a policy-gated table
 * neither raises nor works: the write matches nothing and the read returns `[]`.
 * A spec that seeds through this client therefore drives a browser against a
 * database it believes it populated. Reach for `adminDb` below instead; the
 * `tests/rls/test-singleton-statement-guard.test.ts` ceiling counts every
 * remaining site here and may only ever fall.
 */
export { db };

/**
 * The database OWNER — the seeding / teardown / direct-DB-assertion client
 * (`tests/helpers/adminDb.ts`, MOTIR-2513), re-exported here so a Playwright
 * spec reaches it the same way it reaches `db` and the choice between the two is
 * made in one import line.
 *
 * Safe under Playwright specifically: `currentWorkerAdminUrl()` appends the
 * `…_test_wN` per-worker suffix ONLY inside a Vitest worker (it keys on
 * `VITEST_DB_BASE_URL`), so outside one it returns `DATABASE_URL` unchanged —
 * the base database, which is the database the E2E lane actually runs against.
 */
export { adminDb };
