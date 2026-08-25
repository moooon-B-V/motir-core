import { currentWorkerUrl } from './parallelDb';

/**
 * Per-worker DATABASE_URL rebind (Story 10.4.1). This MUST be the FIRST entry
 * in `vitest.config.ts`'s `setupFiles`, and it MUST NOT import `@/lib/db`.
 *
 * `lib/db.ts` reads `process.env.DATABASE_URL` once, at module-evaluation, to
 * build the Prisma client's pg adapter. Each Vitest worker is its own process,
 * so pointing DATABASE_URL at this worker's cloned database BEFORE the `db`
 * singleton is first imported gives every worker its own connection + database
 * — the isolation that lets `fileParallelism: true` be safe. Ordering it ahead
 * of `inngestSetup.ts` (which DOES import `db`) is what guarantees the rebind
 * wins.
 *
 * The worker DBs themselves are provisioned by the globalSetup
 * (tests/setup/globalDb.ts) before any worker forks.
 *
 * Idempotency: a worker runs many test files, and setupFiles re-run per file
 * while `process.env` persists across them. So we capture the ORIGINAL base URL
 * into `VITEST_DB_BASE_URL` exactly once (on the first file, while DATABASE_URL
 * still points at the base), and always derive the worker URL from that stable
 * capture — never from the already-rebound DATABASE_URL.
 */
if (!process.env['VITEST_DB_BASE_URL']) {
  process.env['VITEST_DB_BASE_URL'] = process.env['DATABASE_URL'];
}
process.env['DATABASE_URL'] = currentWorkerUrl();
// ⚠️ REBIND THE UNPOOLED NAME TOO, or the isolation holds under one name only.
// `lib/jobs/engine/notify.ts` prefers `DATABASE_URL_UNPOOLED` for its LISTEN
// connection (a transaction-mode pooler cannot hold a session — MOTIR-3454), and
// CI sets no such variable, so today it falls through to the line above and
// lands on this worker's clone by accident rather than by design. A developer
// whose `.env` sets it — `.env.example` documents it — would instead get a
// listener on the BASE database while the NOTIFY went to the clone, and
// "delivers a notification to a listening worker" would fail with nothing in the
// diff to explain it. A worker must touch only its own database under EVERY name
// that can reach one.
process.env['DATABASE_URL_UNPOOLED'] = currentWorkerUrl();
