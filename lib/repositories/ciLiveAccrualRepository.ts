import type { Prisma } from '@/generated/prisma/client';

// Data access for the LIVE CI ACCRUAL (Story MOTIR-6906 · MOTIR-6910 ·
// `docs/decisions/fleet-per-org-pool.md` §3) — one row per live CI container per
// debit period, the whole minutes it accrued since its previous row.
//
// Every caller is a background path under `withSystemContext` (the table's policy
// is `app.system_admin` only), so every method takes the transaction.

export interface CiLiveAccrualCreateInput {
  provisioningIntentId: string;
  organizationId: string;
  workspaceId: string;
  runId: string;
  runAttempt: number;
  tickStart: Date;
  periodStart: Date;
  accruedSeconds: number;
}

export const ciLiveAccrualRepository = {
  /**
   * Write one period's accrual. Answers false when this (intent, period) already
   * has its row — a replayed or retried tick — so the caller adds nothing to the
   * rollup. `skipDuplicates` makes the unique index the guard rather than a
   * read-then-write.
   */
  async create(data: CiLiveAccrualCreateInput, tx: Prisma.TransactionClient): Promise<boolean> {
    const { count } = await tx.ciLiveAccrual.createMany({ data: [data], skipDuplicates: true });
    return count === 1;
  },

  /** What one container has accrued live so far — the checkpoint the next tick
   *  subtracts from. Read under the intent's row lock. */
  async sumSecondsForIntent(
    provisioningIntentId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const agg = await tx.ciLiveAccrual.aggregate({
      where: { provisioningIntentId },
      _sum: { accruedSeconds: true },
    });
    return agg._sum.accruedSeconds ?? 0;
  },

  /** What one GitHub run attempt was already charged live, across all of its
   *  jobs' containers — the completion meter's reconciliation input. */
  async sumSecondsForRun(
    runId: string,
    runAttempt: number,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const agg = await tx.ciLiveAccrual.aggregate({
      where: { runId, runAttempt },
      _sum: { accruedSeconds: true },
    });
    return agg._sum.accruedSeconds ?? 0;
  },
};
