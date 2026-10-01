import { afterAll, describe, expect, it, vi } from 'vitest';
import { db, dbPool } from '@/lib/db';
import type * as Db from '@/lib/db';
import type * as TransactionStall from '@/lib/monitoring/transactionStall';

// THE POOL MUST BE READABLE FROM A DIFFERENT COPY OF THE MODULE (MOTIR-7007).
//
// In production every P2028 reported `tx.pool_*` = `unmeasured` while its
// event-loop tags were numeric. Next compiles `instrumentation.ts` into its own
// module graph, so `lib/db.ts` (reached from a route) registers its pool in ONE
// evaluation of `transactionStall.ts`, and the Sentry `beforeSend` (installed
// by `sentry.server.config.ts`, reached from instrumentation) reads ANOTHER —
// whose module-level pool was never set. `transactionStall.test.ts` could not
// see it: vitest evaluates each module once per file, so there the writer and
// the reader always share one binding.
//
// These tests rebuild the production shape — distinct module instances via
// `vi.resetModules()` — and fail against a module-level pool.

type StallModule = typeof TransactionStall;

async function freshInstance(): Promise<StallModule> {
  vi.resetModules();
  return import('@/lib/monitoring/transactionStall');
}

/** A real P2028 (the `timeout` half), from the test Postgres. */
async function realP2028(): Promise<unknown> {
  try {
    await db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1`;
        await new Promise((resolve) => setTimeout(resolve, 400));
        await tx.$queryRaw`SELECT 1`;
      },
      { timeout: 200 },
    );
  } catch (err) {
    return err;
  }
  throw new Error('expected the transaction to fail with P2028, and it committed');
}

afterAll(async () => {
  // Leave the process-wide registration holding exactly the real pool again.
  const stall = await freshInstance();
  stall.clearTransactionStallPools();
  stall.registerTransactionStallPool(dbPool()!);
});

describe('the pool registered in one module instance is read by another', () => {
  it('reports the pool `lib/db.ts` registered to a reader in a separate instance', async () => {
    const err = await realP2028();
    expect((err as { code?: string }).code).toBe('P2028');

    // `lib/db.ts` was evaluated by this file's own graph and registered its pool
    // there; the reader below is a fresh evaluation, as the Sentry hook is.
    const reader = await freshInstance();
    const tags = reader.transactionStallTags(err)!;
    const pool = dbPool()!;

    expect(tags[reader.STALL_TAG.poolMax]).toBe(String(pool.options.max));
    expect(tags[reader.STALL_TAG.poolTotal]).toMatch(/^\d+$/);
    expect(tags[reader.STALL_TAG.poolIdle]).toMatch(/^\d+$/);
    expect(tags[reader.STALL_TAG.poolWaiting]).toMatch(/^\d+$/);
  }, 30_000);

  it('reads exactly the counts a different instance registered', async () => {
    const err = await realP2028();

    const writer = await freshInstance();
    const reader = await freshInstance();
    // Without this, the test would pass against a module-level pool too.
    expect(reader).not.toBe(writer);

    writer.clearTransactionStallPools();
    writer.registerTransactionStallPool({
      totalCount: 7,
      idleCount: 3,
      waitingCount: 2,
      options: { max: 9 },
    });

    const tags = reader.transactionStallTags(err)!;
    expect(tags[reader.STALL_TAG.half]).toBe('timeout');
    expect(tags[reader.STALL_TAG.poolTotal]).toBe('7');
    expect(tags[reader.STALL_TAG.poolIdle]).toBe('3');
    expect(tags[reader.STALL_TAG.poolWaiting]).toBe('2');
    expect(tags[reader.STALL_TAG.poolMax]).toBe('9');
    expect(tags[reader.STALL_TAG.poolCount]).toBe('1');
  }, 30_000);

  it('reports `unmeasured` — not a stale pool — once the registration is cleared', async () => {
    const writer = await freshInstance();
    const reader = await freshInstance();
    writer.clearTransactionStallPools();

    const tags = reader.transactionStallTags(
      Object.assign(new Error('Transaction API error: x'), { code: 'P2028' }),
    )!;
    expect(tags[reader.STALL_TAG.poolTotal]).toBe('unmeasured');
    expect(tags[reader.STALL_TAG.poolMax]).toBe('unmeasured');
    expect(tags[reader.STALL_TAG.poolCount]).toBe('unmeasured');
    expect(tags[reader.STALL_TAG.busiestWaiting]).toBe('unmeasured');
  });
});

// EVERY POOL IN THE PROCESS IS REPORTED, NOT THE LAST ONE REGISTERED (MOTIR-7073).
//
// The WRITER is evaluated more than once too. The Next server runs `lib/db.ts`
// once per Turbopack runtime (route handlers and pages are two), and in
// production each evaluation builds its own client and pool — the `globalThis`
// reuse is dev-only. With one registration slot the last runtime won, so a route
// handler's `maxWait` P2028 read a page runtime's empty pool: 0 total, 0
// waiting. These tests evaluate `lib/db.ts` twice the production way — no
// stashed client, `NODE_ENV=production` — and fail against a single slot.

type DbModule = typeof Db;

const p2028 = () =>
  Object.assign(
    new Error('Transaction API error: Unable to start a transaction in the given time.'),
    { code: 'P2028' },
  );

/** Two production-shaped evaluations of `lib/db.ts`, each with its own pool. */
async function twoDbInstances(): Promise<[DbModule, DbModule]> {
  const stash = globalThis as { prisma?: unknown; prismaPool?: unknown };
  const saved = { prisma: stash.prisma, prismaPool: stash.prismaPool };
  delete stash.prisma;
  delete stash.prismaPool;
  vi.stubEnv('NODE_ENV', 'production');
  try {
    vi.resetModules();
    const first = await import('@/lib/db');
    vi.resetModules();
    const second = await import('@/lib/db');
    return [first, second];
  } finally {
    vi.unstubAllEnvs();
    Object.assign(stash, saved);
  }
}

describe('two `lib/db.ts` evaluations in one process', () => {
  it.each(['first', 'last'] as const)(
    'a connection held on the pool evaluated %s shows in the reading',
    async (which) => {
      (await freshInstance()).clearTransactionStallPools();
      const [first, second] = await twoDbInstances();
      const busyPool = (which === 'first' ? first : second).dbPool()!;
      const otherPool = (which === 'first' ? second : first).dbPool()!;
      // Without this, one shared pool would pass too.
      expect(busyPool).not.toBe(otherPool);

      const held = await busyPool.connect();
      try {
        const reader = await freshInstance();
        const tags = reader.transactionStallTags(p2028())!;
        expect(tags[reader.STALL_TAG.poolCount]).toBe('2');
        expect(tags[reader.STALL_TAG.poolTotal]).toBe('1');
        expect(tags[reader.STALL_TAG.poolIdle]).toBe('0');
        expect(tags[reader.STALL_TAG.poolMax]).toBe('20');
        expect(tags[reader.STALL_TAG.busiestTotal]).toBe('1');
        expect(tags[reader.STALL_TAG.busiestIdle]).toBe('0');
        expect(tags[reader.STALL_TAG.busiestWaiting]).toBe('0');
        expect(tags[reader.STALL_TAG.busiestMax]).toBe('10');
      } finally {
        held.release();
        // Neither client ever ran a query, so `$disconnect()` alone would leave
        // its pool open; end both pools directly.
        await Promise.all([first.dbPool()!.end(), second.dbPool()!.end()]);
      }

      // An ended pool is no longer reported.
      const reader = await freshInstance();
      expect(reader.transactionStallTags(p2028())![reader.STALL_TAG.poolCount]).toBe('unmeasured');
    },
    30_000,
  );

  it('registering a second pool does not drop the first, and one pool twice counts once', async () => {
    const writerA = await freshInstance();
    const writerB = await freshInstance();
    const reader = await freshInstance();
    writerA.clearTransactionStallPools();

    const starved = { totalCount: 10, idleCount: 0, waitingCount: 4, options: { max: 10 } };
    const quiet = { totalCount: 2, idleCount: 2, waitingCount: 0, options: {} };
    writerA.registerTransactionStallPool(starved);
    writerB.registerTransactionStallPool(quiet);
    writerB.registerTransactionStallPool(quiet);

    const tags = reader.transactionStallTags(p2028())!;
    expect(tags[reader.STALL_TAG.poolCount]).toBe('2');
    expect(tags[reader.STALL_TAG.poolTotal]).toBe('12');
    expect(tags[reader.STALL_TAG.poolIdle]).toBe('2');
    expect(tags[reader.STALL_TAG.poolWaiting]).toBe('4');
    // An unset `max` is pg's default of 10.
    expect(tags[reader.STALL_TAG.poolMax]).toBe('20');
    expect(tags[reader.STALL_TAG.busiestTotal]).toBe('10');
    expect(tags[reader.STALL_TAG.busiestIdle]).toBe('0');
    expect(tags[reader.STALL_TAG.busiestWaiting]).toBe('4');
    expect(tags[reader.STALL_TAG.busiestMax]).toBe('10');
  });

  it('with no waiters anywhere, the busiest pool is the one with the most connections in use', async () => {
    const stall = await freshInstance();
    stall.clearTransactionStallPools();
    stall.registerTransactionStallPool({
      totalCount: 5,
      idleCount: 5,
      waitingCount: 0,
      options: {},
    });
    stall.registerTransactionStallPool({
      totalCount: 3,
      idleCount: 0,
      waitingCount: 0,
      options: {},
    });
    const tags = stall.transactionStallTags(p2028())!;
    expect(tags[stall.STALL_TAG.busiestTotal]).toBe('3');
    expect(tags[stall.STALL_TAG.busiestIdle]).toBe('0');
  });
});
