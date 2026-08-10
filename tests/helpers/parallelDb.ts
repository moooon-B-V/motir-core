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

/**
 * The TEST-ONLY credentials for the non-bypass runtime role (MOTIR-2513).
 *
 * `globalDb` provisions this password on the role itself, so a fresh CI Postgres
 * needs no new secret and `scripts/db-up.sh` need not have run. It is a test
 * credential and nothing else: no deployed environment reads it, and the
 * deployed cutover (MOTIR-2515) generates its own into a secret store.
 */
export const TEST_APP_ROLE = process.env['TEST_APP_DB_ROLE'] ?? 'motir_app';
export const TEST_APP_ROLE_PASSWORD = process.env['TEST_APP_DB_PASSWORD'] ?? 'motir_app';

/**
 * Whether this run exercises the code under test as the NON-BYPASS role.
 *
 * OPT-IN, and deliberately so. Under the app role the workspace RLS policies
 * actually execute, which is the point — but the existing suite's fixtures seed
 * and assert through `@/lib/db` with no workspace context, so they are denied
 * wholesale (measured 2026-08-09: 299 of 421 tests failing across a 36-file
 * sample, against 441 test files that import `db`). Migrating those is
 * MOTIR-2514's to size, not this card's. Unset — the default, and what CI runs —
 * every helper here resolves exactly as it did before this flag existed.
 */
export function isAppRoleTestMode(): boolean {
  return process.env['TEST_DB_APP_ROLE'] === '1';
}

/** Rewrite a connection string's userinfo to the app role's test credentials. */
function withAppRoleCredentials(raw: string): string {
  const u = new URL(raw);
  u.username = TEST_APP_ROLE;
  u.password = TEST_APP_ROLE_PASSWORD;
  return u.toString();
}

/**
 * The DATABASE_URL pointing at the current worker's own database.
 *
 * Under the app-role flag this carries the NON-BYPASS role, so `@/lib/db` — the
 * singleton every service and repository imports — connects as it and the RLS
 * policies bite on the code under test. Fixtures and teardown do NOT go through
 * this; they use `currentWorkerAdminUrl()` (see `tests/helpers/adminDb.ts`).
 */
export function currentWorkerUrl(): string {
  const u = baseUrl();
  u.pathname = `/${workerDbName(currentWorkerIndex())}`;
  const url = u.toString();
  return isAppRoleTestMode() ? withAppRoleCredentials(url) : url;
}

/**
 * The current worker's database as the OWNER — the second half of the two-client
 * model (MOTIR-2513).
 *
 * Fixtures and teardown need privileges the runtime role does not have and must
 * never be granted: `TRUNCATE` requires ownership, and seeding across tenants is
 * exactly what the policies exist to forbid. So the admin client keeps using the
 * base URL's credentials whether or not the app-role flag is set — which also
 * means this is unaffected by that flag, by design.
 *
 * ⚠️ THE PER-WORKER SUFFIX IS APPLIED ONLY INSIDE A VITEST WORKER. The `…_test_wN`
 * databases are provisioned by `tests/setup/globalDb.ts`, which is a Vitest
 * `globalSetup` — they do not exist anywhere else. **Playwright imports these
 * same helpers** (`tests/e2e/_helpers/db-reset.ts` calls `truncateAuthTables`)
 * and runs against `DATABASE_URL` directly, with no worker fan-out. Appending a
 * suffix there points at a database that was never created:
 *
 *     Raw query failed. Code: `3D000`. Message: `database "prodect_test_w1" does not exist`
 *
 * which is what nine of eleven E2E shards did when this helper first landed.
 * `currentWorkerIndex()` defaults to 1 when `VITEST_POOL_ID` is unset, so the
 * wrong name is produced silently rather than by throwing.
 *
 * The signal is `VITEST_DB_BASE_URL`: `perWorkerDb` sets it as the FIRST
 * setupFile, before anything can import this module, so it is present in every
 * Vitest worker and absent everywhere else.
 */
export function currentWorkerAdminUrl(): string {
  const raw = process.env['DATABASE_URL'];
  if (!process.env['VITEST_DB_BASE_URL']) {
    // Not inside a Vitest worker — Playwright, a script, an ad-hoc process. The
    // base database IS the database; there is no clone to point at.
    if (!raw) {
      throw new Error('DATABASE_URL is not set — the admin test client needs it.');
    }
    return raw;
  }
  const u = baseUrl();
  u.pathname = `/${workerDbName(currentWorkerIndex())}`;
  return u.toString();
}
