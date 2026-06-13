import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { currentWorkerIndex, workerDbName } from '../helpers/parallelDb';

/**
 * Story 10.4.1 — proves the per-worker database isolation that lets the suite
 * run with `fileParallelism: true`. If the rebind (tests/helpers/perWorkerDb.ts)
 * or the clone (tests/setup/globalDb.ts) regresses, this fails loudly instead of
 * the suite silently sharing one DB again (and flaking under parallelism).
 */
describe('per-worker database isolation', () => {
  it("connects to THIS worker's own cloned database, not the shared base", async () => {
    const rows = await db.$queryRawUnsafe<{ current_database: string }[]>(
      'SELECT current_database()',
    );
    const current = rows[0]?.current_database;
    // Every worker is on a `…_test_wN` clone — never the base DB (which would
    // mean the rebind didn't take and parallel workers share one database).
    expect(current).toMatch(/_test_w\d+$/);
    // …and specifically THIS worker's database, per VITEST_POOL_ID.
    expect(current).toBe(workerDbName(currentWorkerIndex()));
  });

  it('preserves the RLS security surface carried by the TEMPLATE clone', async () => {
    // The non-bypass app role is cluster-level, so a cloned DB still sees it.
    const roles = await db.$queryRawUnsafe<{ rolname: string }[]>(
      "SELECT rolname FROM pg_roles WHERE rolname = 'prodect_app'",
    );
    expect(roles).toHaveLength(1);

    // RLS policies are copied with the database by CREATE DATABASE … TEMPLATE.
    // work_item is RLS-protected (the 20260601 work-item-RLS migration), so the
    // clone must carry its policies — otherwise tenant isolation would silently
    // not apply on the worker DBs.
    const policyRows = await db.$queryRawUnsafe<{ policies: number }[]>(
      "SELECT count(*)::int AS policies FROM pg_policies WHERE tablename = 'work_item'",
    );
    expect(policyRows[0]?.policies ?? 0).toBeGreaterThan(0);

    // And RLS is actually ENABLED on the table in the clone.
    const rlsRows = await db.$queryRawUnsafe<{ relrowsecurity: boolean }[]>(
      "SELECT relrowsecurity FROM pg_class WHERE relname = 'work_item'",
    );
    expect(rlsRows[0]?.relrowsecurity).toBe(true);
  });
});
