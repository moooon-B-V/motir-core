import type { RateLimitStore } from '@/lib/api/v1/rateLimit';
import { createPostgresRateLimitStore } from '@/lib/rateLimit/postgresStore';
import { __setSharedRateLimitStoreForTest } from '@/lib/rateLimit/store';
import { TEST_RATE_LIMIT_STORE_TIMEOUT_MS } from './rateLimitStoreDeadline';

// THE TEST-TIME STORE DEADLINE — the one definition, for the same reason
// `rateLimitWindow.ts` next door is the one definition of the window phase
// (MOTIR-2224 / MOTIR-2648: a fix that lives as a local const in one test file
// is invisible to the next author, and the class outlives it).
//
// ── WHAT THIS IS FOR (MOTIR-3067) ────────────────────────────────────────────
// `createPostgresRateLimitStore()` puts a hard `DEFAULT_RATE_LIMIT_STORE_TIMEOUT_MS`
// (250 ms) deadline on ONE counter increment, and `consumeSharedRateLimit`
// deliberately FAILS OPEN when it expires: `{ allowed: true, degraded: true }`,
// so `enforceRateLimit` returns `response: null` and the request is served.
// That is the right production contract — a brief over-serve beats an outage
// caused by the thing meant to prevent one.
//
// It is also, unstated, a precondition of every test that asserts a request was
// REFUSED. Such a test is asserting two things at once: that the budget was
// spent, AND that the counter was reachable inside 250 ms. The second is a
// property of the machine, not of the code under test — and on a CI shard
// running 5 000+ tests against a shared Postgres it is not reliably true. When
// it fails the assertion reads `expected null not to be null`, on a diff that
// touched no rate-limiting code at all.
//
// So a test that asserts a refusal STATES the precondition instead of inheriting
// it, by handing the store a deadline chosen for a test runner rather than for a
// live request. Nothing about the limiter changes; the test simply stops
// asserting something it never meant to assert.
//
// ⚠️ THIS IS NOT FOR THE CASES THAT EXERCISE THE FAIL-OPEN ARM. Those pin a
// deliberately TINY deadline of their own (`tests/rateLimit/sharedStore.test.ts`
// at 20 ms, `tests/api/v1/shared-store.test.ts` at 50 ms) and must keep it —
// handing them a generous one would delete the coverage. They are named in
// `tests/rateLimit/storeDeadline.test.ts`'s `DEADLINE_IS_THE_SUBJECT` map.

// The deadline itself lives in `rateLimitStoreDeadline.ts`, which imports
// nothing — so a structural guard can read the number without dragging the
// Prisma client in behind it (MOTIR-3144). Re-exported here so every existing
// importer of this helper keeps working unchanged.
export { TEST_RATE_LIMIT_STORE_TIMEOUT_MS };

/**
 * The real Postgres store, with a test-time deadline instead of the production
 * one.
 *
 * ⚠️ A DEADLINE OVERRIDE, NOT A DIFFERENT BACKEND — this is the same adapter
 * the deployment resolves, writing the same counter rows through the same
 * service. Only the number changes. A test that swapped in a fake here would
 * stop proving the thing it exists to prove.
 *
 * Use it with whichever setter the surface under test reads:
 * `__setSharedRateLimitStoreForTest` for the app-level limiters, `setRateLimitStore`
 * for `/api/v1`.
 */
export function testDeadlineRateLimitStore(
  timeoutMs: number = TEST_RATE_LIMIT_STORE_TIMEOUT_MS,
): RateLimitStore {
  return createPostgresRateLimitStore({ timeoutMs });
}

/**
 * Install {@link testDeadlineRateLimitStore} as the SHARED store — the one
 * `consumeSharedRateLimit` (and therefore every `enforce*RateLimit` guard, the
 * MCP gate, the attachment / public-submit / idea-draft limiters, and `/api/v1`'s
 * unpinned default) resolves.
 *
 * Call it in `beforeEach`, AFTER `__resetSharedRateLimitStoreForTest()` if the
 * suite calls that: the reset drops the override this installs.
 */
export function pinSharedRateLimitStoreDeadline(
  timeoutMs: number = TEST_RATE_LIMIT_STORE_TIMEOUT_MS,
): void {
  __setSharedRateLimitStoreForTest(testDeadlineRateLimitStore(timeoutMs));
}
