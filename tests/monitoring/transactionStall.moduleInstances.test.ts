import { afterAll, describe, expect, it, vi } from 'vitest';
import { db, dbPool } from '@/lib/db';
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
  // Leave the process-wide registration pointing at the real pool again.
  (await freshInstance()).setTransactionStallPool(dbPool());
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

    writer.setTransactionStallPool({
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
  }, 30_000);

  it('reports `unmeasured` — not a stale pool — once the registration is cleared', async () => {
    const writer = await freshInstance();
    const reader = await freshInstance();
    writer.setTransactionStallPool(null);

    const tags = reader.transactionStallTags(
      Object.assign(new Error('Transaction API error: x'), { code: 'P2028' }),
    )!;
    expect(tags[reader.STALL_TAG.poolTotal]).toBe('unmeasured');
    expect(tags[reader.STALL_TAG.poolMax]).toBe('unmeasured');
  });
});
