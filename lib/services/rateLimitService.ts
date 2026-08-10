import { db } from '@/lib/db';
import { rateLimitCounterRepository } from '@/lib/repositories/rateLimitCounterRepository';

// Rate-limit counter service (Subtask 8.5.9 / MOTIR-1165) — the transaction
// owner for the SHARED counter table (CLAUDE.md 4-layer: the route-edge limiter
// never touches Prisma, and the repository never opens a transaction).
//
// There is deliberately no business logic here beyond owning the transaction and
// deriving the row's TTL: the DECISION (is this over the budget?) belongs to
// `consumeSharedRateLimit`, which compares against what `increment` returned.

/** How many expired rows one sweep pass deletes before yielding. */
export const RATE_LIMIT_SWEEP_BATCH_SIZE = 5_000;
/** How many passes one sweep run makes before leaving the rest for tomorrow. */
export const RATE_LIMIT_SWEEP_MAX_BATCHES = 20;

export const rateLimitService = {
  /**
   * Count one request against `key`'s current window and return the new count.
   *
   * One statement inside one transaction. The `$transaction` is what satisfies
   * the required-`tx` contract on the repository write; the atomicity that
   * matters is the statement's own `ON CONFLICT DO UPDATE … RETURNING`, which
   * would be correct even unwrapped.
   */
  async increment(key: string, windowStart: number, windowMs: number): Promise<number> {
    const expiresAt = new Date(windowStart + windowMs);
    return db.$transaction((tx) =>
      rateLimitCounterRepository.increment(key, BigInt(windowStart), expiresAt, tx),
    );
  },

  /**
   * Delete counters whose window has passed, in bounded batches.
   *
   * Bounded rather than one big `DELETE`: the table is written on essentially
   * every limited request, so a long-running delete holding locks over a large
   * slice is the one way this sweep could hurt the thing it maintains. Stops
   * early as soon as a pass finds nothing, and leaves any remainder for the next
   * run (the job is idempotent by construction — deleted rows stop matching).
   */
  async sweepExpired(
    now: Date = new Date(),
    batchSize: number = RATE_LIMIT_SWEEP_BATCH_SIZE,
  ): Promise<{ deleted: number; batches: number }> {
    let deleted = 0;
    let batches = 0;
    for (let pass = 0; pass < RATE_LIMIT_SWEEP_MAX_BATCHES; pass += 1) {
      const removed = await db.$transaction((tx) =>
        rateLimitCounterRepository.deleteExpired(now, batchSize, tx),
      );
      batches += 1;
      deleted += removed;
      // A short batch means the backlog is drained. A FULL one means there is
      // more, so go round again — up to the per-run cap, which is what keeps a
      // large backlog from turning one nightly run into a long lock on a hot
      // table. `batchSize` is a parameter only so a test can force the
      // multi-pass path without writing thousands of rows; the job never passes
      // it.
      if (removed < batchSize) break;
    }
    return { deleted, batches };
  },
};
