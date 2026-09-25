import { beforeEach } from 'vitest';

/**
 * The TEST-TIME rate-limit store deadline, installed for every DB-backed file
 * by default (MOTIR-6278).
 *
 * `createPostgresRateLimitStore()` gives one counter increment a 250 ms
 * production deadline and FAILS OPEN when it expires. That is the right
 * contract for a live request, and it has a consequence for a test: the
 * increment is ABANDONED, not cancelled, so its transaction is still open —
 * `idle in transaction` on `INSERT INTO "rate_limit_counter"` — when the
 * request has already been served and the test has ended. On a loaded CI shard
 * the deadline expires often enough that any test driving a rate-limited
 * surface (every MCP call, every `ai:internal` route, …) can leave one behind,
 * which the suite-wide in-flight check (`inFlightProbe.ts`) then fails —
 * two such tests went red in two consecutive CI runs of the PR that turned the
 * check on, in files that had nothing to do with rate limiting.
 *
 * So the default is the same one `pinSharedRateLimitStoreDeadline()` already
 * gives the suites that assert a refusal (MOTIR-3067): the real Postgres
 * store, with a deadline sized for a test runner, so the request waits for its
 * own write. A DEADLINE, not a different backend — the counter rows are still
 * written, through the same adapter and service.
 *
 * ORDER: a `setupFiles` `beforeEach` runs BEFORE the test file's own. So a
 * file whose SUBJECT is the store — which store resolves, the production
 * deadline, the fail-open arm — still gets exactly what it asks for: it calls
 * `__resetSharedRateLimitStoreForTest()` (which drops this override) or pins its
 * own deadline, and either runs after this. Those files are named in
 * `tests/rateLimit/storeDeadline.test.ts`'s `DEADLINE_IS_THE_SUBJECT` map.
 *
 * SCOPE: only a file that opened a Prisma client (the same gate the in-flight
 * check uses) — a pure component file has no store to pin, and the import is
 * dynamic so it does not load the service tree.
 */
beforeEach(async () => {
  const opened = globalThis as unknown as { prisma?: unknown; adminPrisma?: unknown };
  if (!opened.prisma && !opened.adminPrisma) return;
  const { pinSharedRateLimitStoreDeadline } = await import('./rateLimitStore');
  pinSharedRateLimitStoreDeadline();
});
