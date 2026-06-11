// Playwright-side DB reset.
//
// Re-uses tests/helpers/db.ts's truncateAuthTables via the same Prisma
// client used everywhere else. A thin wrapper rather than a direct
// import-and-call so Playwright callers always go through this module —
// if the reset surface needs to grow (e.g. seed data, clear outbox file)
// we extend here without touching the Vitest helper.
import { rmSync } from 'node:fs';
import { db } from '@/lib/db';
import { truncateAuthTables } from '@/tests/helpers/db';

const EMAIL_OUTBOX_PATH = process.env['EMAIL_OUTBOX_PATH'] ?? '/tmp/motir-test-emails.jsonl';

/**
 * Truncates the auth-related tables (user, account, session, verification)
 * AND clears the file outbox the dev server writes reset links to. Both
 * must be reset together — leaving the outbox alone would let a previous
 * test's reset link leak into the next test's `waitForEmail` call.
 *
 * Safe to call from a Playwright `test.beforeEach`. Idempotent.
 *
 * Retries on Postgres deadlock (40P01): the PREVIOUS test can leave Inngest
 * jobs still querying through the dev server (e.g. the 5.1 mention fan-out
 * trailing the comments journey), and TRUNCATE deadlocking against those
 * in-flight transactions is a transient ordering collision, not a test
 * failure — the job finishes within moments and the retry succeeds.
 */
export async function resetDatabase(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await truncateAuthTables();
      break;
    } catch (err) {
      const deadlock = err instanceof Error && /40P01|deadlock/i.test(err.message);
      if (!deadlock || attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  rmSync(EMAIL_OUTBOX_PATH, { force: true });
}

/**
 * Re-export the Prisma client so specs can assert post-conditions on
 * the database without importing @/lib/db directly. Keeps "what
 * Playwright touches in the DB layer" discoverable in one file.
 */
export { db };
