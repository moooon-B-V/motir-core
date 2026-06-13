import { Client } from 'pg';
import {
  TEST_DB_WORKERS,
  adminConnectionString,
  baseDbName,
  workerDbName,
} from '../helpers/parallelDb';

/**
 * Vitest globalSetup (Story 10.4.1) — provision one database PER WORKER so the
 * suite can run with `fileParallelism: true` without cross-worker row
 * interference. Runs ONCE in the main process before any worker forks.
 *
 * Each worker DB is a `CREATE DATABASE … TEMPLATE <base>` clone of the migrated
 * base database (the one CI's `prisma migrate deploy` just built, or the local
 * dev DB). The TEMPLATE clone is a fast file-copy that carries the full schema,
 * the RLS policies, and the per-DB GRANTs; the non-bypass `prodect_app` role is
 * cluster-level so it is already present. We DROP+recreate so a re-run starts
 * from a clean clone.
 *
 * Notes:
 *   - `CREATE DATABASE` can't run inside a transaction and can't target the DB
 *     you're connected to, so we connect to the cluster's `postgres` DB.
 *   - The base (template) must have no other active connections at clone time.
 *     The suite's workers connect to their OWN `…_test_wN` DBs (never the base),
 *     and this setup does not import `@/lib/db`, so nothing in this run holds
 *     the base open. (Close a local dev server pointed at the base before
 *     running the suite.)
 *   - Identifiers are interpolated (pg has no DDL placeholders) but are internal
 *     constants derived from the base DB name — never user input.
 */

async function dropWorkerDb(admin: Client, name: string): Promise<void> {
  // Kill any lingering connections to this worker DB (e.g. a crashed prior
  // run) so DROP doesn't block; never touches the base/template DB.
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [name],
  );
  await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
}

export async function setup(): Promise<void> {
  const base = baseDbName();
  const admin = new Client({ connectionString: adminConnectionString() });
  await admin.connect();
  try {
    for (let i = 1; i <= TEST_DB_WORKERS; i++) {
      const name = workerDbName(i);
      await dropWorkerDb(admin, name);
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${base}"`);
    }
  } finally {
    await admin.end();
  }
}

export async function teardown(): Promise<void> {
  const admin = new Client({ connectionString: adminConnectionString() });
  await admin.connect();
  try {
    for (let i = 1; i <= TEST_DB_WORKERS; i++) {
      await dropWorkerDb(admin, workerDbName(i));
    }
  } finally {
    await admin.end();
  }
}
