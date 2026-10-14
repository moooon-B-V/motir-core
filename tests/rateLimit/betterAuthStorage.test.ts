import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { truncateRateLimitCounters } from '@/tests/helpers/db';
import {
  createBetterAuthRateLimitStorage,
  betterAuthRateLimitKey,
  BETTER_AUTH_RATE_LIMIT_PREFIX,
} from '@/lib/rateLimit/betterAuthStorage';
import { RateLimitStoreTimeoutError } from '@/lib/rateLimit/postgresStore';
import { authOptions } from '@/lib/auth';
import { rateLimitCounterRepository } from '@/lib/repositories/rateLimitCounterRepository';
import {
  pinSharedRateLimitStoreDeadline,
  testDeadlineRateLimitStore,
} from '@/tests/helpers/rateLimitStore';
import { __resetSharedRateLimitStoreForTest } from '@/lib/rateLimit/store';

// Better-Auth's limiter on the SHARED counter (MOTIR-8613), against the REAL
// Postgres. Two `createBetterAuthRateLimitStorage()` calls stand in for two
// machines: each owns its own adapter, and the only thing they share is the
// `rate_limit_counter` table — which is the whole property under test.
//
// The clock is INJECTED and pinned to the middle of a window, so no window
// boundary can land inside a case and reset a count it is about to refuse. The
// store deadline is the shared test-time one for the same reason: a refusal that fails open on
// a slow runner would read as an allow.

const IP_KEY = '203.0.113.9|/request-password-reset';
const HOUR = { window: 3600, max: 3 };
const SIGN_IN = { window: 10, max: 3 };

/** A machine: its own adapter over its own Postgres store instance. */
function machine(now: () => number) {
  return createBetterAuthRateLimitStorage(testDeadlineRateLimitStore(), {
    now,
  });
}

beforeEach(async () => {
  await truncateRateLimitCounters();
  // The machines below carry their own store; this covers anything that
  // resolves `sharedRateLimitStore()` instead (MOTIR-3067).
  pinSharedRateLimitStoreDeadline();
});
afterEach(() => {
  vi.restoreAllMocks();
  __resetSharedRateLimitStoreForTest();
});
afterAll(async () => {
  await db.$disconnect();
});

describe('two machines count ONE bucket', () => {
  it('3 per hour split 2 + 1 across machines, and the 4th is refused on either', async () => {
    // 10 minutes into an hour window.
    const t = 1_000 * 3600 * 500 + 600_000;
    const a = machine(() => t);
    const b = machine(() => t);

    expect(await a.consume(IP_KEY, HOUR)).toEqual({ allowed: true, retryAfter: null });
    expect(await a.consume(IP_KEY, HOUR)).toEqual({ allowed: true, retryAfter: null });
    expect(await b.consume(IP_KEY, HOUR)).toEqual({ allowed: true, retryAfter: null });

    const onA = await a.consume(IP_KEY, HOUR);
    const onB = await b.consume(IP_KEY, HOUR);
    for (const refused of [onA, onB]) {
      expect(refused.allowed).toBe(false);
      expect(refused.retryAfter).toBeGreaterThanOrEqual(1);
      expect(refused.retryAfter).toBeLessThanOrEqual(3600);
    }
    // 50 minutes remain in the window.
    expect(onA.retryAfter).toBe(3000);
  });

  it('the sign-in rule (3 per 10 s) behaves the same, and a new window allows again', async () => {
    let t = 1_000 * 10 * 900_000 + 2_000; // 2 s into a 10 s window
    const a = machine(() => t);
    const b = machine(() => t);
    const key = '203.0.113.9|/sign-in/email';

    await a.consume(key, SIGN_IN);
    await b.consume(key, SIGN_IN);
    await a.consume(key, SIGN_IN);
    const refused = await b.consume(key, SIGN_IN);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfter).toBe(8);

    t += 10_000; // past windowStart + windowMs
    expect(await a.consume(key, SIGN_IN)).toEqual({ allowed: true, retryAfter: null });
  });

  it('different Better-Auth keys never share a bucket', async () => {
    const t = 1_000 * 3600 * 501 + 1_000;
    const a = machine(() => t);
    for (let i = 0; i < 3; i += 1) await a.consume(IP_KEY, HOUR);
    expect((await a.consume('198.51.100.1|/request-password-reset', HOUR)).allowed).toBe(true);
  });
});

describe('the stored key', () => {
  it('is prefixed and hashed — no plaintext IP reaches the table', async () => {
    const t = 1_000 * 3600 * 502;
    const a = machine(() => t);
    await a.consume(IP_KEY, HOUR);

    const stored = betterAuthRateLimitKey(IP_KEY);
    expect(await rateLimitCounterRepository.countAllUnsafe()).toBe(1);
    expect(await rateLimitCounterRepository.findCountUnsafe(stored, BigInt(t))).toBe(1);
    expect(stored.startsWith(BETTER_AUTH_RATE_LIMIT_PREFIX)).toBe(true);
    expect(stored).not.toContain('203.0.113.9');
    expect(stored).not.toContain('/request-password-reset');
  });
});

describe('fail open', () => {
  it('a store timeout allows the request and logs once', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const storage = createBetterAuthRateLimitStorage({
      increment: () => Promise.reject(new RateLimitStoreTimeoutError(250)),
    });

    await expect(storage.consume(IP_KEY, HOUR)).resolves.toEqual({
      allowed: true,
      retryAfter: null,
    });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[1]).toBeInstanceOf(RateLimitStoreTimeoutError);
  });
});

describe('the authOptions wiring', () => {
  it('sets customStorage, and keeps enabled and the password-reset rule', () => {
    expect(authOptions.rateLimit?.customStorage?.consume).toBeTypeOf('function');
    expect(authOptions.rateLimit?.storage).toBeUndefined();
    expect(authOptions.rateLimit?.customRules?.['/request-password-reset']).toEqual({
      window: 3600,
      max: 3,
    });
    // `enabled` reads E2E_DISABLE_RATE_LIMIT at module load; this run leaves it unset.
    expect(authOptions.rateLimit?.enabled).toBe(process.env['E2E_DISABLE_RATE_LIMIT'] !== '1');
  });

  it('E2E_DISABLE_RATE_LIMIT=1 still turns the limiter off', async () => {
    const previous = process.env['E2E_DISABLE_RATE_LIMIT'];
    process.env['E2E_DISABLE_RATE_LIMIT'] = '1';
    try {
      vi.resetModules();
      const fresh = await import('@/lib/auth');
      expect(fresh.authOptions.rateLimit?.enabled).toBe(false);
      expect(fresh.authOptions.rateLimit?.customStorage).toBeDefined();
    } finally {
      if (previous === undefined) delete process.env['E2E_DISABLE_RATE_LIMIT'];
      else process.env['E2E_DISABLE_RATE_LIMIT'] = previous;
    }
  });
});
