import { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';

// Rate-limit counter repository (Subtask 8.5.9 / MOTIR-1165) — single Prisma
// operations on the SHARED `rate_limit_counter` table. Per CLAUDE.md: write
// methods require `tx: Prisma.TransactionClient`; no business logic and no
// transactions here — `rateLimitService` owns those.
//
// ⚠️ `increment` is the load-bearing method and it is ONE statement. The
// interface it serves (`RateLimitStore.increment`, `lib/api/v1/rateLimit.ts`)
// is documented as INDIVISIBLE: it must increment the counter and return the NEW
// value in one step. `INSERT … ON CONFLICT DO UPDATE … RETURNING count` is that
// step. A read-then-write pair — with or without an `await` between — would let
// two concurrent requests both observe the stale count and both pass, leaking
// the limit under exactly the concurrent load the limiter exists to control.
// Pinned in `docs/decisions/production-service-stack.md` §6.

export const rateLimitCounterRepository = {
  /**
   * Count one request against `(key, windowStart)` and return the resulting
   * count — the caller compares against the budget using THIS value, never one
   * read beforehand.
   *
   * `expiresAt` is `windowStart + windowMs`, supplied by the caller as a JS
   * `Date` rather than computed with SQL `NOW()` so the row's lifetime is
   * derived from the same clock that chose the window (no app/DB skew).
   */
  async increment(
    key: string,
    windowStart: bigint,
    expiresAt: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ count: number }>>`
      INSERT INTO "rate_limit_counter" ("key", "window_start", "count", "expires_at")
      VALUES (${key}, ${windowStart}, 1, ${expiresAt})
      ON CONFLICT ("key", "window_start")
      DO UPDATE SET "count" = "rate_limit_counter"."count" + 1
      RETURNING "count"
    `;
    // `RETURNING` on an INSERT … ON CONFLICT DO UPDATE always yields exactly one
    // row (the inserted or the updated one), so the fallback is unreachable; it
    // exists so a `count` of 0 can never read as "allowed" if it somehow were.
    /* v8 ignore next */
    return rows[0]?.count ?? 1;
  },

  /**
   * Delete every counter whose window has already passed — the daily sweep's
   * only write. Bounded by `limit` so one run cannot lock a large slice of the
   * table; the job re-runs until a pass deletes nothing.
   */
  async deleteExpired(before: Date, limit: number, tx: Prisma.TransactionClient): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ deleted: bigint }>>`
      WITH doomed AS (
        SELECT "key", "window_start"
          FROM "rate_limit_counter"
         WHERE "expires_at" < ${before}
         LIMIT ${limit}
      )
      DELETE FROM "rate_limit_counter" t
       USING doomed d
       WHERE t."key" = d."key" AND t."window_start" = d."window_start"
      RETURNING 1 AS deleted
    `;
    return rows.length;
  },

  /** Test-only direct read of one bucket (asserts the counter actually moved). */
  async findCountUnsafe(key: string, windowStart: bigint): Promise<number | null> {
    const rows = await db.$queryRaw<Array<{ count: number }>>`
      SELECT "count" FROM "rate_limit_counter"
       WHERE "key" = ${key} AND "window_start" = ${windowStart}
    `;
    return rows[0]?.count ?? null;
  },

  /** Test-only row count, for asserting the sweep removed what it should. */
  async countAllUnsafe(): Promise<number> {
    const rows = await db.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM "rate_limit_counter"
    `;
    // A bare `count(*)` always returns exactly one row, so the fallback is
    // unreachable — it exists only to satisfy the possibly-undefined index.
    /* v8 ignore next */
    return Number(rows[0]?.n ?? 0);
  },
};
