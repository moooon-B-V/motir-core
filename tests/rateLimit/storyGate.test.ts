import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  BETTER_AUTH_RATE_LIMIT_PREFIX,
  betterAuthRateLimitKey,
  createBetterAuthRateLimitStorage,
} from '@/lib/rateLimit/betterAuthStorage';
import {
  createPostgresRateLimitStore,
  RateLimitStoreTimeoutError,
} from '@/lib/rateLimit/postgresStore';
import {
  __resetSharedRateLimitStoreForTest,
  assertRateLimitStoreAllowed,
  MemoryRateLimitStoreRefusedError,
  RATE_LIMIT_STORE_ENV,
  resolveRateLimitBackend,
} from '@/lib/rateLimit/store';
import { resetRequestDbTimingForTests } from '@/lib/monitoring/requestDbTiming';
import { adminDb } from '../helpers/adminDb';
import { truncateRateLimitCounters } from '../helpers/db';
import {
  pinSharedRateLimitStoreDeadline,
  testDeadlineRateLimitStore,
} from '../helpers/rateLimitStore';
import { sleep, waitForWindowHeadroom } from '../helpers/rateLimitWindow';

// THE STORY GATE OVER THE ASSEMBLED RATE-LIMIT CHANGES (Story MOTIR-8547 ·
// MOTIR-8619, cases 1-8).
//
// Each blocker shipped its own focused tests — `betterAuthStorage.test.ts`
// (MOTIR-8613) and `storeGuard.test.ts` (MOTIR-8614). This file asserts what
// they assembled into: the storage Better-Auth is ACTUALLY configured with
// (`authOptions.rateLimit.customStorage`, not a fresh adapter), counting in the
// real `rate_limit_counter` table through the store the deployment resolves, and
// the guard at the boot call that runs it.
//
// No store is faked. The fail-open case gets its `RateLimitStoreTimeoutError`
// from the REAL Postgres store, by holding a row lock on the bucket from a
// second connection until the increment outlives its deadline.

const HOUR = { window: 3600, max: 3 };

beforeEach(async () => {
  await truncateRateLimitCounters();
  pinSharedRateLimitStoreDeadline();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  __resetSharedRateLimitStoreForTest();
});
afterAll(async () => {
  await db.$disconnect();
});

/** The storage `lib/auth` configures Better-Auth with — imported fresh per case. */
async function configuredStorage() {
  const { authOptions } = await import('@/lib/auth');
  const storage = authOptions.rateLimit?.customStorage;
  if (!storage) throw new Error('authOptions.rateLimit.customStorage is not set');
  return storage;
}

describe('case 2 — the configured storage counts once across two instances', () => {
  it('3 per hour across authOptions’ storage and an independent one; the 4th is refused on either', async () => {
    // Both adapters read the real clock: a case that starts in a window's last
    // 10 s would watch the reset land mid-sequence.
    await waitForWindowHeadroom(HOUR.window * 1000, 10_000);
    const a = await configuredStorage();
    const b = createBetterAuthRateLimitStorage(testDeadlineRateLimitStore());
    const key = '203.0.113.50|/request-password-reset';

    expect(await a.consume(key, HOUR)).toEqual({ allowed: true, retryAfter: null });
    expect(await b.consume(key, HOUR)).toEqual({ allowed: true, retryAfter: null });
    expect(await a.consume(key, HOUR)).toEqual({ allowed: true, retryAfter: null });

    for (const refused of [await a.consume(key, HOUR), await b.consume(key, HOUR)]) {
      expect(refused.allowed).toBe(false);
      expect(refused.retryAfter).toBeGreaterThanOrEqual(1);
      expect(refused.retryAfter).toBeLessThanOrEqual(3600);
    }
  });
});

describe('case 3 — the stored key', () => {
  it('starts with ba: and carries no plaintext IP, read from the counter table itself', async () => {
    await waitForWindowHeadroom(HOUR.window * 1000, 10_000);
    const ip = '203.0.113.51';
    await (await configuredStorage()).consume(`${ip}|/sign-in/email`, HOUR);

    const stored = await adminDb.rateLimitCounter.findMany();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.key).toBe(betterAuthRateLimitKey(`${ip}|/sign-in/email`));
    expect(stored[0]!.key.startsWith(BETTER_AUTH_RATE_LIMIT_PREFIX)).toBe(true);
    expect(stored[0]!.key).not.toContain(ip);
    expect(stored[0]!.key).not.toContain('sign-in');
  });
});

describe('case 4 — fail open on the real store’s deadline', () => {
  it('a bucket locked by another connection times out the increment, and the request is allowed', async () => {
    const t = 1_000 * 3600 * 700 + 60_000;
    const key = '203.0.113.52|/sign-in/email';
    const stored = betterAuthRateLimitKey(key);
    // A real Postgres store with a short deadline — the production adapter, only
    // the number changed.
    const storage = createBetterAuthRateLimitStorage(
      createPostgresRateLimitStore({ timeoutMs: 100 }),
      {
        now: () => t,
      },
    );
    expect(await storage.consume(key, HOUR)).toEqual({ allowed: true, retryAfter: null });

    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = adminDb.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "count" FROM "rate_limit_counter" WHERE "key" = ${stored} FOR UPDATE`;
        locked();
        await released;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );

    try {
      await isLocked;
      await expect(storage.consume(key, HOUR)).resolves.toEqual({
        allowed: true,
        retryAfter: null,
      });
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0]?.[1]).toBeInstanceOf(RateLimitStoreTimeoutError);
    } finally {
      release();
      await holder;
    }

    // The abandoned increment still lands once the lock goes — fail-open is a
    // decision about the REQUEST, not a lost count. Waiting for it also keeps
    // the write from outliving this case.
    for (let i = 0; i < 100; i += 1) {
      const row = await adminDb.rateLimitCounter.findFirst({ where: { key: stored } });
      if (row?.count === 2) break;
      await sleep(50);
    }
    expect((await adminDb.rateLimitCounter.findFirst({ where: { key: stored } }))?.count).toBe(2);
  });
});

describe('case 5 — E2E_DISABLE_RATE_LIMIT is the only switch', () => {
  it('=1 turns the limiter off; unset leaves it on, with the shared storage either way', async () => {
    vi.stubEnv('E2E_DISABLE_RATE_LIMIT', '1');
    const off = (await import('@/lib/auth')).authOptions.rateLimit;
    expect(off?.enabled).toBe(false);
    expect(off?.customStorage).toBeDefined();

    vi.resetModules();
    vi.stubEnv('E2E_DISABLE_RATE_LIMIT', undefined);
    const on = (await import('@/lib/auth')).authOptions.rateLimit;
    expect(on?.enabled).toBe(true);
    expect(on?.customStorage).toBeDefined();
    expect(on?.storage).toBeUndefined();
  });
});

describe('case 6 — assertRateLimitStoreAllowed, as store.ts exports it', () => {
  it.each(['memory', 'MEMORY', ' memory '])(
    'production + %j is refused, naming the env var',
    (v) => {
      const call = () =>
        assertRateLimitStoreAllowed({ NODE_ENV: 'production', [RATE_LIMIT_STORE_ENV]: v });
      expect(call).toThrow(MemoryRateLimitStoreRefusedError);
      expect(call).toThrow(/MOTIR_RATE_LIMIT_STORE/);
    },
  );

  it.each<[string, Record<string, string | undefined>]>([
    ['production + postgres', { NODE_ENV: 'production', [RATE_LIMIT_STORE_ENV]: 'postgres' }],
    ['production + unset', { NODE_ENV: 'production' }],
    ['non-production + memory', { NODE_ENV: 'test', [RATE_LIMIT_STORE_ENV]: 'memory' }],
  ])('%s returns normally', (_label, env) => {
    expect(assertRateLimitStoreAllowed(env)).toBeUndefined();
  });

  it('reads process.env when handed nothing', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv(RATE_LIMIT_STORE_ENV, 'memory');
    expect(() => assertRateLimitStoreAllowed()).toThrow(MemoryRateLimitStoreRefusedError);
    vi.stubEnv(RATE_LIMIT_STORE_ENV, 'postgres');
    expect(() => assertRateLimitStoreAllowed()).not.toThrow();
  });
});

describe('case 7 — instrumentation.ts runs the guard at boot', () => {
  // ⚠️ DEVIATION FROM THE CARD'S WORDING, which says `register` "rejects" on
  // `memory`. Since MOTIR-8614 it EXITS instead: measured on `next start` and on
  // the standalone server (Next 16.3.6), a throw from `register()` is logged and
  // the process keeps listening, so a throw would not stop the deploy. The test
  // therefore spies `process.exit` — made to throw, so nothing after it runs —
  // and asserts the exit code and the message.
  beforeEach(() => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('NODE_ENV', 'production');
  });
  afterEach(() => resetRequestDbTimingForTests());

  it('memory → it logs the refusal and exits 1 before anything else boots', async () => {
    vi.stubEnv(RATE_LIMIT_STORE_ENV, 'memory');
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${String(code)})`);
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { register } = await import('@/instrumentation');
    await expect(register()).rejects.toThrow('process.exit(1)');
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('MOTIR_RATE_LIMIT_STORE="memory"'));
  });

  it('postgres → it resolves and never exits', async () => {
    vi.stubEnv(RATE_LIMIT_STORE_ENV, 'postgres');
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${String(code)})`);
    });

    const { register } = await import('@/instrumentation');
    await expect(register()).resolves.toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('case 8 — the memory escape hatch outside production is intact', () => {
  it('resolveRateLimitBackend() still resolves memory when asked for it', () => {
    vi.stubEnv(RATE_LIMIT_STORE_ENV, 'memory');
    expect(resolveRateLimitBackend()).toBe('memory');
    vi.stubEnv(RATE_LIMIT_STORE_ENV, ' Memory ');
    expect(resolveRateLimitBackend()).toBe('memory');
  });
});

describe('coverage top-ups — the adapter’s defaults and boundary', () => {
  it('a storage built with no store and no clock resolves the shared store and reads Date.now', async () => {
    await waitForWindowHeadroom(10_000, 4_000);
    const storage = createBetterAuthRateLimitStorage();
    const key = '203.0.113.53|/sign-up/email';
    const rule = { window: 10, max: 1 };
    expect(await storage.consume(key, rule)).toEqual({ allowed: true, retryAfter: null });
    const refused = await storage.consume(key, rule);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfter).toBeGreaterThanOrEqual(1);
    expect(refused.retryAfter).toBeLessThanOrEqual(10);
  });

  it('retryAfter is at least 1 in a window’s last millisecond, and the next window allows again', async () => {
    let t = 1_000 * 10 * 950_000 + 9_999; // 1 ms before the boundary
    const storage = createBetterAuthRateLimitStorage(testDeadlineRateLimitStore(), {
      now: () => t,
    });
    const key = '203.0.113.54|/change-password';
    const rule = { window: 10, max: 1 };
    await storage.consume(key, rule);
    expect(await storage.consume(key, rule)).toEqual({ allowed: false, retryAfter: 1 });
    t += 1; // exactly the next window's start
    expect(await storage.consume(key, rule)).toEqual({ allowed: true, retryAfter: null });
  });
});
