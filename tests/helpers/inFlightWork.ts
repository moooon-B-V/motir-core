import { adminDb } from './adminDb';

/**
 * A backend still doing work on THIS worker's database (MOTIR-3066).
 *
 * `state` is Postgres': `active` (a statement is executing) or
 * `idle in transaction` (a transaction is open with no statement running).
 * Either one holds locks.
 */
export interface InFlightBackend {
  pid: number;
  state: string;
  query: string;
}

/**
 * Every OTHER client backend on this worker's database that is not idle.
 *
 * The suite gives each Vitest worker its own `…_test_wN` database
 * (`tests/setup/globalDb.ts`), and the worker→database mapping is one-to-one:
 * `VITEST_POOL_ID` is allocated from a fixed pool of `[1, maxWorkers]` slots and
 * `maxWorkers` is pinned to the provisioned count (`tests/helpers/parallelDb.ts`).
 * So `datname = current_database()` scopes this to the calling process, and
 * anything it returns is work THIS worker started and did not wait for.
 *
 * `backend_type = 'client backend'` drops autovacuum, which visits the worker
 * databases constantly and holds nothing the reset contends with.
 *
 * WHY THIS IS WORTH ASSERTING. `tests/helpers/db.ts`'s reset is a
 * `TRUNCATE … CASCADE`, which takes `AccessExclusiveLock` on twelve named tables
 * and every table that cascades from them, in ITS order. An abandoned read holds
 * `AccessShareLock` on the tables its own plan reached, in the PLANNER's order.
 * The two orders overlap and disagree, so the reset and the leftover deadlock —
 * `40P01`, raised against whichever of the two Postgres picks as the victim. When
 * that victim is the reset, the failure surfaces as a `beforeEach` throwing in a
 * test whose body never ran (MOTIR-3066).
 *
 * The invariant is therefore not "the truncate helpers agree on an order" — they
 * cannot agree with an arbitrary SELECT's plan. It is that **nothing else is
 * running when the reset runs**, which holds exactly when every operation a test
 * starts is awaited before that test ends.
 */
export async function inFlightBackends(): Promise<InFlightBackend[]> {
  const rows = await adminDb.$queryRawUnsafe<InFlightBackend[]>(
    `SELECT pid::int AS pid, state, left(query, 300) AS query
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND backend_type = 'client backend'
        AND pid <> pg_backend_pid()
        AND state <> 'idle'
      ORDER BY pid`,
  );
  return rows;
}

/** A one-line-per-backend rendering for an assertion message. */
export function describeInFlight(rows: InFlightBackend[]): string {
  return rows.map((r) => `  pid ${r.pid} [${r.state}] ${r.query.replace(/\s+/g, ' ')}`).join('\n');
}
