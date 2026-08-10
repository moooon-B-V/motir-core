import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/v1/me/route';
import { db } from '@/lib/db';
import { tokenFingerprint } from '@/lib/api/v1/bearer';
import {
  __useDefaultRateLimitStoreForTest,
  rateLimitBudget,
  setRateLimitStore,
} from '@/lib/api/v1/rateLimit';
import {
  createPostgresRateLimitStore,
  DEFAULT_RATE_LIMIT_STORE_TIMEOUT_MS,
} from '@/lib/rateLimit/postgresStore';
import {
  RATE_LIMIT_STORE_ENV,
  __resetSharedRateLimitStoreForTest,
  sharedRateLimitStore,
} from '@/lib/rateLimit/store';
import { rateLimitCounterRepository } from '@/lib/repositories/rateLimitCounterRepository';
import { rateLimitService } from '@/lib/services/rateLimitService';
import { createV1Caller, withTokenFor } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables, truncateRateLimitCounters } from '../../helpers/db';
import { ALIGNED_WINDOW_MS, sleep, waitForWindowBoundary } from '../../helpers/rateLimitWindow';

// `/api/v1` counts through the SHARED store (Subtask 8.5.10 — MOTIR-2037).
//
// ── What this suite exists to prove, and why its siblings cannot ─────────────
// `tests/api/v1/rate-limit.test.ts` proves the limiter's BEHAVIOUR — the
// headers, the 429, the envelope, the per-token split. It calls
// `resetRateLimitStore()` in a `beforeEach`, which pins a fresh in-process
// counter, because those assertions need an empty counter and emptiness is not
// something the shared store can hand back by swapping an object.
//
// So that suite says nothing about WHERE the tally is kept — which is the whole
// of this card. This one therefore never calls `resetRateLimitStore()`: it
// drives the shipped wrapper in the state a real process starts in, and asserts
// the counter it lands in is the shared table, one window wide across clients.
//
// ⚠️ The headline case drives TWO STORE CLIENTS. One client counting to its own
// budget proves nothing about sharing — an in-process Map passes that test
// perfectly. The defect being closed is that machine A and machine B each kept
// their own window, so the assertion has to involve two independent counters
// agreeing, which is what a second `createPostgresRateLimitStore()` stands in
// for. Fly runs `machine_count: 2` today, so this is the deployed topology, not
// a hypothetical one.

const ME = 'http://localhost:3000/api/v1/me';

function req(headers: Record<string, string>) {
  return new Request(ME, { headers });
}

/** The counter key the wrapper will use for this caller — its token's hash. */
function keyFor(caller: { token: string }): string {
  return tokenFingerprint(caller.token);
}

/** The window cell `consumeRateLimit` is in right now, for a given window. */
function currentWindowStart(windowMs: number): number {
  return Math.floor(Date.now() / windowMs) * windowMs;
}

const savedEnv = {
  limit: process.env['MOTIR_API_V1_RATE_LIMIT'],
  window: process.env['MOTIR_API_V1_RATE_LIMIT_WINDOW_MS'],
  store: process.env[RATE_LIMIT_STORE_ENV],
};

/** Set the budget the way a deployment would. */
function budget(limit: number, windowMs: number) {
  process.env['MOTIR_API_V1_RATE_LIMIT'] = String(limit);
  process.env['MOTIR_API_V1_RATE_LIMIT_WINDOW_MS'] = String(windowMs);
}

function restoreEnv() {
  for (const [name, saved] of [
    ['MOTIR_API_V1_RATE_LIMIT', savedEnv.limit],
    ['MOTIR_API_V1_RATE_LIMIT_WINDOW_MS', savedEnv.window],
    [RATE_LIMIT_STORE_ENV, savedEnv.store],
  ] as const) {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

beforeEach(async () => {
  await truncateAuthTables();
  await truncateRateLimitCounters();
  // Back to the state a fresh process is in: nothing pinned here, and the
  // shared store's memo cleared so it re-reads the environment.
  __useDefaultRateLimitStoreForTest();
  __resetSharedRateLimitStoreForTest();
  delete process.env[RATE_LIMIT_STORE_ENV];
});

afterEach(() => {
  vi.restoreAllMocks();
  __useDefaultRateLimitStoreForTest();
  __resetSharedRateLimitStoreForTest();
  restoreEnv();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('the wrapper counts through the SHARED store by default', () => {
  it('writes the token’s count to the shared counter TABLE — no wiring step required', async () => {
    // Aligned even though only ONE request is counted: the assertion names the
    // window cell the row must be in, so a boundary crossing between the request
    // and the read would look exactly like a missing row.
    budget(10, ALIGNED_WINDOW_MS);
    const caller = await createV1Caller();
    await waitForWindowBoundary(ALIGNED_WINDOW_MS);
    const windowStart = currentWindowStart(ALIGNED_WINDOW_MS);

    const res = await GET(req(caller.headers));

    expect(res.status).toBe(200);
    expect(res.headers.get('x-ratelimit-remaining')).toBe('9');
    // The row is the point: nothing in production calls `setRateLimitStore`, so
    // if the default were still the in-process Map this read would be null.
    expect(
      await rateLimitCounterRepository.findCountUnsafe(keyFor(caller), BigInt(windowStart)),
    ).toBe(1);
  });

  it('resolves the same store object the app-level limiters use', async () => {
    // One store, not two implementations of the same idea: `/api/v1` and the
    // auth / public-write / AI guards share the counter (they keep their own
    // budgets — sharing a store is not sharing a ceiling).
    budget(10, ALIGNED_WINDOW_MS);
    const shared = sharedRateLimitStore();
    const caller = await createV1Caller();
    await waitForWindowBoundary(ALIGNED_WINDOW_MS);
    const windowStart = currentWindowStart(rateLimitBudget().windowMs);

    await GET(req(caller.headers));
    // The app-level side, writing the SAME key through its own entry point,
    // continues v1's count rather than starting a second one.
    const next = await shared.increment(keyFor(caller), windowStart, rateLimitBudget().windowMs);

    expect(next).toBe(2);
  });
});

describe('TWO STORE CLIENTS enforce ONE window — the defect this card closes', () => {
  it('spending the budget through a SECOND client refuses the wrapper’s next request', async () => {
    // The two-machine case, made deterministic. `other` is a store client the
    // wrapper has never seen — a stand-in for the second Fly machine — and the
    // budget it spends is the budget the wrapper then finds gone.
    const LIMIT = 3;
    budget(LIMIT, ALIGNED_WINDOW_MS);
    const caller = await createV1Caller();
    await waitForWindowBoundary(ALIGNED_WINDOW_MS);
    const other = createPostgresRateLimitStore();
    const windowStart = currentWindowStart(ALIGNED_WINDOW_MS);

    for (let i = 0; i < LIMIT; i++) {
      await other.increment(keyFor(caller), windowStart, ALIGNED_WINDOW_MS);
    }

    const refused = await GET(req(caller.headers));

    expect(refused.status).toBe(429);
    expect(refused.headers.get('x-ratelimit-remaining')).toBe('0');
    // Under the old per-process counter this request was the FIRST of its
    // window and would have been served with `remaining: 2`.
    const body = (await refused.json()) as { code: string };
    expect(body.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('the two clients count into ONE row, not one row each', async () => {
    budget(10, ALIGNED_WINDOW_MS);
    const caller = await createV1Caller();
    await waitForWindowBoundary(ALIGNED_WINDOW_MS);
    const other = createPostgresRateLimitStore();
    const windowStart = currentWindowStart(ALIGNED_WINDOW_MS);

    await GET(req(caller.headers));
    await other.increment(keyFor(caller), windowStart, ALIGNED_WINDOW_MS);
    await GET(req(caller.headers));

    expect(
      await rateLimitCounterRepository.findCountUnsafe(keyFor(caller), BigInt(windowStart)),
    ).toBe(3);
    expect(await rateLimitCounterRepository.countAllUnsafe()).toBe(1);
  });

  it('does NOT pool two tokens of the same user into one budget', async () => {
    // Sharing the STORE must not blur the KEY: the fix would be worse than the
    // defect if one integration could now exhaust another's allowance.
    budget(2, ALIGNED_WINDOW_MS);
    const first = await createV1Caller();
    const second = await withTokenFor(first.user, first.workspace, { label: 'second' });
    await waitForWindowBoundary(ALIGNED_WINDOW_MS);

    expect((await GET(req(first.headers))).status).toBe(200);
    expect((await GET(req(first.headers))).status).toBe(200);
    expect((await GET(req(first.headers))).status).toBe(429);

    expect((await GET(req(second.headers))).status).toBe(200);
  });
});

describe('the shared counter stays ATOMIC and time-bounded under the wrapper', () => {
  // The property a read → compare → write store fails. A serial loop passes
  // against a broken implementation; simultaneous requests do not — and this is
  // the assertion that has to survive the move from a single-threaded Map to a
  // database several connections are hitting at once.
  it('fires N SIMULTANEOUS requests against a budget of N−1 and refuses exactly one', async () => {
    const N = 12;
    budget(N - 1, ALIGNED_WINDOW_MS);
    const caller = await createV1Caller();
    await waitForWindowBoundary(ALIGNED_WINDOW_MS);

    const statuses = (
      await Promise.all(Array.from({ length: N }, () => GET(req(caller.headers))))
    ).map((r) => r.status);

    expect(statuses.filter((s) => s === 200)).toHaveLength(N - 1);
    expect(statuses.filter((s) => s === 429)).toHaveLength(1);
  });

  it('resets when the window rolls over — a new window is a new row', async () => {
    const ROLLOVER_WINDOW_MS = 2_000;
    budget(1, ROLLOVER_WINDOW_MS);
    const caller = await createV1Caller();
    await waitForWindowBoundary(ROLLOVER_WINDOW_MS);

    expect((await GET(req(caller.headers))).status).toBe(200);
    const refused = await GET(req(caller.headers));
    expect(refused.status).toBe(429);

    // Wait past the reset the response itself advertised — a real rollover, not
    // a mocked clock.
    const resetAtMs = Number(refused.headers.get('x-ratelimit-reset')) * 1000;
    await sleep(Math.max(0, resetAtMs - Date.now()) + 100);

    expect((await GET(req(caller.headers))).status).toBe(200);
    // Two rows for one token: the old window's and the new one's. The sweep
    // (MOTIR-1165) is what eventually removes the first.
    expect(await rateLimitCounterRepository.countAllUnsafe()).toBe(2);
  });
});

describe('a shared store in the request path still FAILS OPEN', () => {
  // Now that the counter is a dependency of every v1 request rather than a Map
  // in the same process, this arm is the difference between a degraded limiter
  // and an outage. Both shapes are forced: one that throws, one that hangs.
  it('ALLOWS the request when the store THROWS, and still emits the headers', async () => {
    budget(1, 60_000);
    setRateLimitStore({
      increment: () => Promise.reject(new Error('the database is unreachable')),
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const caller = await createV1Caller();

    // Well past a budget of 1 — every one of these is served anyway.
    for (let i = 0; i < 3; i++) {
      const res = await GET(req(caller.headers));
      expect(res.status).toBe(200);
      expect(res.headers.get('x-ratelimit-limit')).toBe('1');
      expect(res.headers.get('x-ratelimit-reset')).toBeTruthy();
    }
    expect(spy).toHaveBeenCalled();
  });

  it('ALLOWS the request when the store HANGS, without holding it open', async () => {
    // The case a bare `catch` cannot reach: a store that never settles never
    // throws. The deadline in `postgresStore.ts` rejects on its behalf, and the
    // wrapper's existing catch treats that like any other store failure.
    budget(1, 60_000);
    const TIMEOUT_MS = 50;
    vi.spyOn(rateLimitService, 'increment').mockReturnValue(new Promise<number>(() => {}));
    setRateLimitStore(createPostgresRateLimitStore({ timeoutMs: TIMEOUT_MS }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const caller = await createV1Caller();

    const startedAt = Date.now();
    const res = await GET(req(caller.headers));
    const elapsed = Date.now() - startedAt;

    expect(res.status).toBe(200);
    expect(res.headers.get('x-ratelimit-limit')).toBe('1');
    // Bounded by the deadline, not by the hung call. Generous upper bound: the
    // assertion is that it RETURNS at all, not that the timer is precise.
    expect(elapsed).toBeLessThan(5_000);
    expect(TIMEOUT_MS).toBeLessThan(DEFAULT_RATE_LIMIT_STORE_TIMEOUT_MS);
  });
});

describe('the single-instance escape hatch', () => {
  it('MOTIR_RATE_LIMIT_STORE=memory keeps the count in the process, writing no row', async () => {
    // The self-hoster running one process: per-process and shared are the same
    // thing there, and this is the arm that lets them skip the write.
    process.env[RATE_LIMIT_STORE_ENV] = 'memory';
    __resetSharedRateLimitStoreForTest();
    budget(2, ALIGNED_WINDOW_MS);
    const caller = await createV1Caller();
    await waitForWindowBoundary(ALIGNED_WINDOW_MS);

    expect((await GET(req(caller.headers))).status).toBe(200);
    expect((await GET(req(caller.headers))).status).toBe(200);
    // Still enforced — the ceiling is real, it is just not shared.
    expect((await GET(req(caller.headers))).status).toBe(429);
    expect(await rateLimitCounterRepository.countAllUnsafe()).toBe(0);
  });
});
