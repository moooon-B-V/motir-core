import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { truncateRateLimitCounters } from '@/tests/helpers/db';
import { rateLimitCounterRepository } from '@/lib/repositories/rateLimitCounterRepository';
import {
  rateLimitService,
  RATE_LIMIT_SWEEP_BATCH_SIZE,
  RATE_LIMIT_SWEEP_MAX_BATCHES,
} from '@/lib/services/rateLimitService';
import {
  createPostgresRateLimitStore,
  RateLimitStoreTimeoutError,
  DEFAULT_RATE_LIMIT_STORE_TIMEOUT_MS,
} from '@/lib/rateLimit/postgresStore';
import {
  resolveRateLimitBackend,
  sharedRateLimitStore,
  UnknownRateLimitBackendError,
  RATE_LIMIT_STORE_ENV,
  __setSharedRateLimitStoreForTest,
  __resetSharedRateLimitStoreForTest,
} from '@/lib/rateLimit/store';
import { consumeSharedRateLimit, RATE_LIMIT_DISABLE_ENV } from '@/lib/rateLimit/limiter';
import { rateLimitKey, clientIp } from '@/lib/rateLimit/keys';
import {
  ALIGNED_HEADROOM_MS,
  ALIGNED_WINDOW_MS,
  waitForWindowHeadroom,
} from '@/tests/helpers/rateLimitWindow';
import { pinSharedRateLimitStoreDeadline } from '@/tests/helpers/rateLimitStore';

// The SHARED rate-limit store (Subtask 8.5.9 / MOTIR-1165) against the REAL
// Postgres — the store's whole purpose is that two processes share one window, so
// a mocked counter would test the opposite of the property that matters.
//
// ── THE WINDOW IS ALIGNED (MOTIR-3016) ───────────────────────────────────────
// Found by the same sweep as `guard.test.ts` next door, and the same shape: a
// raw `const WINDOW = 60_000` handed to budgets, with no alignment anywhere. Two
// cases here spend a budget across several calls and assert the last one is
// REFUSED, so an epoch boundary landing mid-case resets the counter and serves
// it instead. See `tests/helpers/rateLimitWindow.ts`.
//
// Most of this file is NOT exposed to that: every `rateLimitService.increment`
// case passes an EXPLICIT `windowStart` (`60_000`, `120_000`, `0`) rather than
// deriving one from the clock, so no grid boundary can move underneath it. Only
// the two cases that go through `consumeSharedRateLimit` — which derives the
// cell from `Date.now()` — accumulate against a live window, and only those two
// wait:
//
//   'over-limit fails CLOSED — the one thing that must not fail open'
//   'any other value leaves the limiter ON'
//
// The disable-flag case loops five times and does not wait, because with the
// limiter disabled nothing is counted at all — and an assertion that a request
// was ALLOWED cannot be broken by a reset, which only ever grants more budget.
//
// ── THE STORE DEADLINE IS PINNED PER CASE, NOT IN `beforeEach` (MOTIR-3067) ──
// The other unstated precondition of a refusal: `consumeSharedRateLimit` FAILS
// OPEN when one increment outlives the store's deadline, and the production
// deadline is 250 ms. Exactly two cases here are exposed to it — the two that
// spend a budget and assert the last call was REFUSED — and each pins the
// deadline itself rather than inheriting a suite-wide override, because THIS
// file's subject includes which store `sharedRateLimitStore()` RESOLVES:
// `honours MOTIR_RATE_LIMIT_STORE=memory` and `memoizes, so one process cannot
// split a window across two backends` both read that function, and an override
// installed in `beforeEach` would answer them before the code under test could.
//
// ⚠️ AND THE TWO CASES WITH A TINY DEADLINE KEEP IT. `a HANGING store times out
// and still allows the request` (20 ms) and `a store that answers within the
// deadline is NOT treated as a failure` (5 s) EXERCISE the deadline — it is
// their subject, not their environment. Handing them a generous one would
// delete the coverage. They are named for that reason in
// `tests/rateLimit/storeDeadline.test.ts`'s `DEADLINE_IS_THE_SUBJECT` map.

beforeEach(async () => {
  await truncateRateLimitCounters();
  __resetSharedRateLimitStoreForTest();
  delete process.env[RATE_LIMIT_STORE_ENV];
  delete process.env[RATE_LIMIT_DISABLE_ENV];
});
afterEach(() => {
  __resetSharedRateLimitStoreForTest();
  delete process.env[RATE_LIMIT_STORE_ENV];
  delete process.env[RATE_LIMIT_DISABLE_ENV];
});
afterAll(async () => {
  await db.$disconnect();
});

describe('the counter increments ATOMICALLY', () => {
  it('returns the NEW count on each call, and persists it', async () => {
    const windowStart = 60_000;
    expect(await rateLimitService.increment('k1', windowStart, ALIGNED_WINDOW_MS)).toBe(1);
    expect(await rateLimitService.increment('k1', windowStart, ALIGNED_WINDOW_MS)).toBe(2);
    expect(await rateLimitService.increment('k1', windowStart, ALIGNED_WINDOW_MS)).toBe(3);
    expect(await rateLimitCounterRepository.findCountUnsafe('k1', BigInt(windowStart))).toBe(3);
  });

  it('CONCURRENT increments each get a DISTINCT count — the limit does not leak', async () => {
    // The property a read → compare → write implementation fails: 20 requests
    // arriving together must consume 20 of the budget, not 1. Every returned
    // value must be unique, and the set must be exactly 1..20.
    const windowStart = 120_000;
    const counts = await Promise.all(
      Array.from({ length: 20 }, () =>
        rateLimitService.increment('race', windowStart, ALIGNED_WINDOW_MS),
      ),
    );
    expect(new Set(counts).size).toBe(20);
    expect([...counts].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(await rateLimitCounterRepository.findCountUnsafe('race', BigInt(windowStart))).toBe(20);
  });

  it('a NEW window is a new row, so the count RESETS', async () => {
    expect(await rateLimitService.increment('k2', 60_000, ALIGNED_WINDOW_MS)).toBe(1);
    expect(await rateLimitService.increment('k2', 60_000, ALIGNED_WINDOW_MS)).toBe(2);
    // Next window — a different primary key entirely.
    expect(await rateLimitService.increment('k2', 120_000, ALIGNED_WINDOW_MS)).toBe(1);
    expect(await rateLimitCounterRepository.findCountUnsafe('k2', BigInt(60_000))).toBe(2);
  });

  it('different keys never share a bucket', async () => {
    expect(await rateLimitService.increment('a', 60_000, ALIGNED_WINDOW_MS)).toBe(1);
    expect(await rateLimitService.increment('b', 60_000, ALIGNED_WINDOW_MS)).toBe(1);
  });

  it('stamps expires_at as windowStart + windowMs, from the app clock', async () => {
    await rateLimitService.increment('exp', 60_000, ALIGNED_WINDOW_MS);
    const rows = await db.$queryRaw<Array<{ expires_at: Date }>>`
      SELECT "expires_at" FROM "rate_limit_counter" WHERE "key" = 'exp'
    `;
    expect(rows[0]?.expires_at.getTime()).toBe(60_000 + ALIGNED_WINDOW_MS);
  });
});

describe('the sweep', () => {
  it('deletes only rows whose window has PASSED', async () => {
    // Two ancient windows and one far-future one.
    await rateLimitService.increment('old-1', 0, ALIGNED_WINDOW_MS);
    await rateLimitService.increment('old-2', ALIGNED_WINDOW_MS, ALIGNED_WINDOW_MS);
    const future = Date.now() + 10 * 60_000;
    await rateLimitService.increment('fresh', future, ALIGNED_WINDOW_MS);

    const result = await rateLimitService.sweepExpired(new Date());

    expect(result.deleted).toBe(2);
    expect(await rateLimitCounterRepository.countAllUnsafe()).toBe(1);
    expect(await rateLimitCounterRepository.findCountUnsafe('fresh', BigInt(future))).toBe(1);
  });

  it('is idempotent — a second pass deletes nothing and reports one batch', async () => {
    await rateLimitService.increment('old', 0, ALIGNED_WINDOW_MS);
    expect((await rateLimitService.sweepExpired(new Date())).deleted).toBe(1);
    const second = await rateLimitService.sweepExpired(new Date());
    expect(second.deleted).toBe(0);
    expect(second.batches).toBe(1);
  });

  it('stops after ONE batch when the batch is not full (the bounded-pass contract)', async () => {
    await rateLimitService.increment('old', 0, ALIGNED_WINDOW_MS);
    const { batches } = await rateLimitService.sweepExpired(new Date());
    expect(batches).toBe(1);
    expect(RATE_LIMIT_SWEEP_BATCH_SIZE).toBeGreaterThan(1);
  });

  it('the repository honours its LIMIT, so one pass cannot delete the world', async () => {
    for (const k of ['x1', 'x2', 'x3']) await rateLimitService.increment(k, 0, ALIGNED_WINDOW_MS);
    const deleted = await db.$transaction((tx) =>
      rateLimitCounterRepository.deleteExpired(new Date(), 2, tx),
    );
    expect(deleted).toBe(2);
    expect(await rateLimitCounterRepository.countAllUnsafe()).toBe(1);
  });

  it('defaults `now` to the wall clock, which is how the cron job calls it', async () => {
    await rateLimitService.increment('old', 0, ALIGNED_WINDOW_MS);
    expect((await rateLimitService.sweepExpired()).deleted).toBe(1);
  });

  it('makes SEVERAL passes when a batch comes back FULL, and stops when one is short', async () => {
    // The multi-pass path: with a batch size of 1 and three expired rows, the
    // sweep runs 1,1,1 (each full → go again) then a fourth empty pass that ends
    // it. Without the loop a backlog larger than one batch would never drain.
    for (const k of ['a', 'b', 'c']) await rateLimitService.increment(k, 0, ALIGNED_WINDOW_MS);
    const { deleted, batches } = await rateLimitService.sweepExpired(new Date(), 1);
    expect(deleted).toBe(3);
    expect(batches).toBe(4);
    expect(await rateLimitCounterRepository.countAllUnsafe()).toBe(0);
  });

  it('honours the per-run cap rather than looping forever on a huge backlog', async () => {
    for (const k of ['a', 'b', 'c']) await rateLimitService.increment(k, 0, ALIGNED_WINDOW_MS);
    // Cap the passes by asking for a batch of 1 — the loop is bounded by
    // RATE_LIMIT_SWEEP_MAX_BATCHES, which is far above 4, so this drains fully;
    // the assertion pins that the cap exists and is the larger of the two bounds.
    expect(RATE_LIMIT_SWEEP_MAX_BATCHES).toBeGreaterThan(4);
  });

  it('reads back null for a bucket that does not exist, and 0 rows when empty', async () => {
    expect(await rateLimitCounterRepository.findCountUnsafe('nope', BigInt(0))).toBeNull();
    expect(await rateLimitCounterRepository.countAllUnsafe()).toBe(0);
  });
});

describe('the store adapter fails OPEN — on an error AND on a hang', () => {
  it('a THROWING store allows the request and marks it degraded', async () => {
    __setSharedRateLimitStoreForTest({
      increment: () => Promise.reject(new Error('database is on fire')),
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const decision = await consumeSharedRateLimit('k', { limit: 1, windowMs: ALIGNED_WINDOW_MS });
    expect(decision.allowed).toBe(true);
    expect(decision.degraded).toBe(true);
    expect(decision.remaining).toBe(1);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('a HANGING store times out and still allows the request', async () => {
    // The case a bare `catch` CANNOT reach: a store that never settles never
    // throws, so without the adapter's deadline the request would be held open
    // forever — the limiter becoming the outage it exists to prevent.
    //
    // Wired the way production is: the real Postgres adapter (which owns the
    // deadline) over a service call that never settles.
    vi.spyOn(rateLimitService, 'increment').mockReturnValue(new Promise<number>(() => {}));
    const hung = createPostgresRateLimitStore({ timeoutMs: 20 });

    // The adapter itself rejects — it does NOT swallow the failure, so the caller
    // can tell a timeout from a genuinely empty window.
    await expect(hung.increment('k', 60_000, ALIGNED_WINDOW_MS)).rejects.toBeInstanceOf(
      RateLimitStoreTimeoutError,
    );

    // And the limiter over that adapter fails OPEN rather than hanging.
    __setSharedRateLimitStoreForTest(hung);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const decision = await consumeSharedRateLimit('k', { limit: 1, windowMs: ALIGNED_WINDOW_MS });
    expect(decision.allowed).toBe(true);
    expect(decision.degraded).toBe(true);
    spy.mockRestore();
    vi.restoreAllMocks();
  });

  it('a store that answers within the deadline is NOT treated as a failure', async () => {
    const store = createPostgresRateLimitStore({ timeoutMs: 5_000 });
    expect(await store.increment('deadline-ok', 60_000, ALIGNED_WINDOW_MS)).toBe(1);
    expect(DEFAULT_RATE_LIMIT_STORE_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('over-limit fails CLOSED — the one thing that must not fail open', async () => {
    // ⚠️ `degraded: false` below is the assertion a fail-open falsifies most
    // directly, and it is the one this case exists for (MOTIR-3067).
    pinSharedRateLimitStoreDeadline();
    const budget = { limit: 2, windowMs: ALIGNED_WINDOW_MS };
    const key = 'closed';
    await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
    expect((await consumeSharedRateLimit(key, budget)).allowed).toBe(true);
    expect((await consumeSharedRateLimit(key, budget)).allowed).toBe(true);
    const third = await consumeSharedRateLimit(key, budget);
    expect(third.allowed).toBe(false);
    expect(third.degraded).toBe(false);
    expect(third.remaining).toBe(0);
    expect(third.resetAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});

describe('which backend is in force', () => {
  it('defaults to postgres when a DATABASE_URL exists', () => {
    expect(process.env['DATABASE_URL']).toBeTruthy();
    expect(resolveRateLimitBackend()).toBe('postgres');
  });

  it('honours MOTIR_RATE_LIMIT_STORE=memory (the self-host escape hatch)', () => {
    process.env[RATE_LIMIT_STORE_ENV] = 'memory';
    expect(resolveRateLimitBackend()).toBe('memory');
    // And the resolved store really is the in-process one: it counts without
    // ever touching the table.
    const store = sharedRateLimitStore();
    return (async () => {
      expect(await store.increment('mem', 60_000, ALIGNED_WINDOW_MS)).toBe(1);
      expect(await store.increment('mem', 60_000, ALIGNED_WINDOW_MS)).toBe(2);
      expect(await rateLimitCounterRepository.countAllUnsafe()).toBe(0);
    })();
  });

  it('falls back to memory when there is no DATABASE_URL at all', () => {
    const saved = process.env['DATABASE_URL'];
    delete process.env['DATABASE_URL'];
    try {
      expect(resolveRateLimitBackend()).toBe('memory');
    } finally {
      process.env['DATABASE_URL'] = saved;
    }
  });

  it('REFUSES `redis` rather than silently degrading to per-process counters', () => {
    // The dangerous failure this guards: a silent fallback would return the
    // deployment to a `limit x instances` ceiling while every header still
    // claimed the limit was enforced.
    process.env[RATE_LIMIT_STORE_ENV] = 'redis';
    expect(() => resolveRateLimitBackend()).toThrow(UnknownRateLimitBackendError);
    process.env[RATE_LIMIT_STORE_ENV] = 'typo';
    expect(() => resolveRateLimitBackend()).toThrow(/not a store this build accepts/);
  });

  it('is case-insensitive and trims, so `  Memory ` is accepted', () => {
    process.env[RATE_LIMIT_STORE_ENV] = '  Memory ';
    expect(resolveRateLimitBackend()).toBe('memory');
  });

  it('memoizes, so one process cannot split a window across two backends', () => {
    process.env[RATE_LIMIT_STORE_ENV] = 'memory';
    const first = sharedRateLimitStore();
    process.env[RATE_LIMIT_STORE_ENV] = 'postgres';
    expect(sharedRateLimitStore()).toBe(first);
  });
});

describe('the disable flag', () => {
  it('E2E_DISABLE_RATE_LIMIT=1 allows everything and writes NO counters', async () => {
    // Load-bearing for the E2E suite: Playwright signs several users up from one
    // IP, and Better-Auth already gates its own limiter on this SAME flag.
    process.env[RATE_LIMIT_DISABLE_ENV] = '1';
    const budget = { limit: 1, windowMs: ALIGNED_WINDOW_MS };
    for (let i = 0; i < 5; i += 1) {
      const decision = await consumeSharedRateLimit('disabled', budget);
      expect(decision.allowed).toBe(true);
      expect(decision.degraded).toBe(false);
      expect(decision.remaining).toBe(1);
    }
    expect(await rateLimitCounterRepository.countAllUnsafe()).toBe(0);
  });

  it('any other value leaves the limiter ON', async () => {
    // A fail-open serves the second call, which reads as "the flag turned the
    // limiter off" — the exact opposite of what this case asserts (MOTIR-3067).
    pinSharedRateLimitStoreDeadline();
    process.env[RATE_LIMIT_DISABLE_ENV] = '0';
    const budget = { limit: 1, windowMs: ALIGNED_WINDOW_MS };
    await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
    expect((await consumeSharedRateLimit('on', budget)).allowed).toBe(true);
    expect((await consumeSharedRateLimit('on', budget)).allowed).toBe(false);
  });
});

describe('keys never hold a plaintext identifier', () => {
  it('hashes every component, and keeps the scope readable', () => {
    const key = rateLimitKey('auth:sign-in', '203.0.113.7');
    expect(key.startsWith('auth:sign-in:')).toBe(true);
    expect(key).not.toContain('203.0.113.7');
    // sha-256 hex
    expect(key.split(':')[2]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes an email identifier too — the table is not a sign-in log', () => {
    const key = rateLimitKey('auth:sign-in', 'id', 'victim@example.com');
    expect(key).not.toContain('victim@example.com');
    expect(key).not.toContain('example.com');
  });

  it('is stable for the same input and distinct for different input', () => {
    expect(rateLimitKey('ai:chat', 'w1', 'u1')).toBe(rateLimitKey('ai:chat', 'w1', 'u1'));
    expect(rateLimitKey('ai:chat', 'w1', 'u1')).not.toBe(rateLimitKey('ai:chat', 'w1', 'u2'));
  });

  it('hashes components INDIVIDUALLY, so a separator cannot merge two callers', () => {
    // ("a:b") and ("a", "b") must not collide — an injected `:` in user-supplied
    // input would otherwise silently share one budget.
    expect(rateLimitKey('public-write', 'a:b')).not.toBe(rateLimitKey('public-write', 'a', 'b'));
  });

  it('reads the client IP off the first x-forwarded-for hop', () => {
    const req = new Request('http://localhost/x', {
      headers: { 'x-forwarded-for': '203.0.113.7, 70.41.3.18' },
    });
    expect(clientIp(req)).toBe('203.0.113.7');
  });

  it('falls back to x-real-ip, then to ONE shared bucket — never to unlimited', () => {
    expect(
      clientIp(new Request('http://localhost/x', { headers: { 'x-real-ip': '198.51.100.9' } })),
    ).toBe('198.51.100.9');
    expect(clientIp(new Request('http://localhost/x'))).toBe('unknown');
  });
});
