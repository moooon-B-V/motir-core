import { availableParallelism } from 'node:os';

/**
 * Per-worker database isolation for the Vitest integration suite (Story 10.4.1).
 *
 * The suite is DB-backed and resets via a global `TRUNCATE … CASCADE`
 * (tests/helpers/db.ts), so it used to run SERIALLY (`fileParallelism: false`)
 * — every file shared one Postgres and parallel forks would corrupt each
 * other's rows. The standard fix (Rails `parallelize`, Ecto SQL Sandbox,
 * Jest/Vitest pool + per-worker DB) is to give each Vitest worker its OWN
 * database, cloned from the migrated base via `CREATE DATABASE … TEMPLATE`.
 *
 * This module is the single source of truth for that wiring — imported by:
 *   - `vitest.config.ts`        → sets `poolOptions.forks.maxForks` to the
 *                                 worker count so VITEST_POOL_ID stays in range.
 *   - `tests/setup/globalDb.ts` → the globalSetup that CREATEs/DROPs the N
 *                                 worker DBs (main process, before workers fork).
 *   - `tests/helpers/perWorkerDb.ts` → the FIRST setupFile, which rebinds
 *                                 DATABASE_URL to this worker's clone BEFORE
 *                                 `@/lib/db` is first imported.
 *
 * It imports ONLY node built-ins (never `@/lib/db`) so the perWorkerDb setup
 * file can run before the `db` singleton reads DATABASE_URL at module-eval.
 */

/**
 * How many worker databases to provision = the parallel-worker count. Capped so
 * a big dev box doesn't clone dozens of DBs; the floor of 1 keeps a single-core
 * / `--no-file-parallelism` run working (it just uses `…_test_w1`). Matches the
 * `maxForks` the config pins, so VITEST_POOL_ID ∈ [1, TEST_DB_WORKERS].
 */
export const TEST_DB_WORKERS = Math.max(1, Math.min(availableParallelism(), 8));

/**
 * The base DATABASE_URL the worker DBs are cloned from (the migrated DB).
 *
 * Prefers `VITEST_DB_BASE_URL` — the STABLE capture of the base that
 * `perWorkerDb` stashes before it rebinds `DATABASE_URL` to a worker clone.
 * Without that, re-reading `DATABASE_URL` after the rebind would yield the
 * already-cloned name and double-append (`…_test_w1_test_w1`) — wrong in the
 * test assertion and, worse, on a worker's SECOND file (setupFiles re-run, env
 * persists across files in a worker). In the main process (globalSetup) the
 * sentinel is unset, so this falls back to `DATABASE_URL` = the base.
 */
function baseUrl(): URL {
  const raw = process.env['VITEST_DB_BASE_URL'] ?? process.env['DATABASE_URL'];
  if (!raw) {
    throw new Error('DATABASE_URL is not set — the per-worker test DB setup needs the base URL.');
  }
  return new URL(raw);
}

/** The base (template) database name, e.g. `prodect`. */
export function baseDbName(): string {
  // URL pathname is `/<dbname>`; strip the leading slash.
  return decodeURIComponent(baseUrl().pathname.replace(/^\//, ''));
}

/**
 * A connection string to the cluster's `postgres` maintenance DB, used by the
 * globalSetup to issue `CREATE DATABASE` / `DROP DATABASE` (which cannot run
 * against the database you're connected to, and cannot run inside a tx).
 */
export function adminConnectionString(): string {
  const u = baseUrl();
  u.pathname = '/postgres';
  return u.toString();
}

/** The worker database name for a 1-based worker index, e.g. `prodect_test_w2`. */
export function workerDbName(index: number): string {
  return `${baseDbName()}_test_w${index}`;
}

/**
 * The 1-based worker index for the CURRENT Vitest worker, derived from
 * VITEST_POOL_ID (Vitest sets it per forked worker). Clamped into
 * [1, TEST_DB_WORKERS] so it always maps to a provisioned DB even if the pool
 * id ever exceeds the configured fork count (defensive — `maxForks` pins it).
 */
export function currentWorkerIndex(): number {
  const raw = Number(process.env['VITEST_POOL_ID'] ?? '1');
  const id = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
  return ((id - 1) % TEST_DB_WORKERS) + 1;
}

/** The DATABASE_URL pointing at the current worker's own database. */
export function currentWorkerUrl(): string {
  const u = baseUrl();
  u.pathname = `/${workerDbName(currentWorkerIndex())}`;
  return u.toString();
}
