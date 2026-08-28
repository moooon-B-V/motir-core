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
import { truncateAuthTables, truncateJobRuns } from '@/tests/helpers/db';

const EMAIL_OUTBOX_PATH = process.env['EMAIL_OUTBOX_PATH'] ?? '/tmp/motir-test-emails.jsonl';

/**
 * Runs a truncating reset under a bounded retry on Postgres deadlock (40P01).
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
 */
export async function withTruncateDeadlockRetry<T>(truncate: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await truncate();
    } catch (err) {
      const deadlock = err instanceof Error && /40P01|deadlock/i.test(err.message);
      if (!deadlock || attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
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
 * Retries on Postgres deadlock (40P01): the PREVIOUS test can leave jobs still
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
