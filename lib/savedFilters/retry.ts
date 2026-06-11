import { Prisma } from '@prisma/client';

/**
 * Run a write flow once, retrying exactly once on a unique-constraint race
 * (P2002) — the labelsService pattern, extracted: two concurrent
 * transactions both pass a uniqueness pre-check (same name, same star), and
 * the loser's insert aborts its (already-poisoned) transaction, so it cannot
 * recover in place — the whole flow re-runs in a FRESH transaction, where
 * the pre-check now sees the winner's row and takes the serial path (the
 * typed conflict, or the idempotent no-op). Any second P2002 (or any other
 * error) propagates.
 */
export async function retryOnceOnUniqueRace<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return run();
    }
    throw err;
  }
}
