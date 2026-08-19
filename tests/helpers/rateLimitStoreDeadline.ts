// The test-time store deadline, alone in a module that imports NOTHING.
//
// ── Why this is not in `rateLimitStore.ts` beside its users (MOTIR-3144) ────
// It was, and that made a filesystem scanner need a database. `storeDeadline.test.ts`
// is a whole-tree structural guard — it reads `tests/**` as text and asserts
// which files bind the helper — and its ONLY runtime dependency was this one
// number. Importing it from `rateLimitStore.ts` pulled in
// `@/lib/rateLimit/postgresStore` → `@/lib/services/rateLimitService` →
// `@/lib/db`, which throws `DATABASE_URL is not set` at module-import time.
//
// So a guard that parses source files could not run without a migrated Postgres,
// purely to read `10_000`. That is what kept it inside the sharded database job,
// where MOTIR-3067 found it failing OPEN under contention, and it is why the
// constant now lives on its own: a value with no dependencies should not be
// reachable only through one.
//
// ⚠️ Keep this module dependency-free. An import added here — even a type-only
// one that later stops being type-only — puts the guard back in the lane it was
// moved out of, and the failure shows up as a rate-limit test flaking on a
// loaded runner rather than as anything to do with this file.
// `tests/ci-structural-guards-lane.test.ts` asserts the lane's membership; the
// emptiness of this file is what keeps that membership honest.

/**
 * The deadline a test hands the shared store.
 *
 * Sized against the runner, not the request. Two bounds fix it:
 *
 *  - **Below `testTimeout`** (15 s, `vitest.config.ts`). A store that genuinely
 *    hangs must fail on THIS deadline — which names the store in the error —
 *    rather than on the test timeout, which names nothing.
 *  - **Far above any honest increment.** One `INSERT … ON CONFLICT DO UPDATE`
 *    against a warm local pool measures in single-digit milliseconds; the
 *    250 ms production budget is ~40x that and still loses on a loaded shared
 *    runner, so the margin has to be an order of magnitude, not a factor of two.
 *
 * 10 s satisfies both with room on each side.
 */
export const TEST_RATE_LIMIT_STORE_TIMEOUT_MS = 10_000;
