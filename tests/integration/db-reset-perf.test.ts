import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-1265 — regression guard for the truncate-hook-timeout flake.
//
// Every DB-backed suite resets between tests with a multi-table
// `TRUNCATE … CASCADE` in a `beforeEach`. With all Vitest worker DBs hosted by
// ONE Postgres cluster, those WAL-logged truncates fire concurrently and their
// commit fsyncs contend on the shared disk, so a truncate occasionally stalled
// past the hook budget (the `beforeEach` ran on Vitest's default 10s
// `hookTimeout`, below even the 15s `testTimeout`) — red-lighting the whole
// "Vitest (integration + coverage)" job and, via merge-with-main CI, every open
// PR.
//
// The root-cause fix sets `synchronous_commit = off` on each worker DB in the
// globalSetup (tests/setup/globalDb.ts): a test worker DB is a disposable
// per-run clone, so trading last-commit durability for the dropped fsync wait
// is free — and that wait is exactly the cost that spiked under load. This test
// asserts the GUC is actually in effect on the DB this worker is bound to, so
// removing the ALTER (or a worker connecting to the wrong DB) fails loudly
// instead of silently reintroducing the flake.
describe('integration DB reset — flake guard (MOTIR-1265)', () => {
  it('runs the worker DB with synchronous_commit off', async () => {
    const rows =
      await db.$queryRawUnsafe<{ synchronous_commit: string }[]>('SHOW synchronous_commit');
    expect(rows[0]?.synchronous_commit).toBe('off');
  });

  it('truncateAuthTables completes well within the hook budget', async () => {
    // A smoke that the reset path runs cleanly against this worker's DB; the
    // value is the assertion that it does not throw / hang, not a hard timing
    // bound (wall-clock under load is the thing we deliberately stopped gating
    // on a tight budget). It still exercises the exact TRUNCATE the flake hit.
    await expect(truncateAuthTables()).resolves.toBeUndefined();
  });
});
