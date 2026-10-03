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

  /** What one organisation accrued live in ticks starting at or after `since` —
   *  the fleet monitor's "accrued in the window" (MOTIR-7316). Rides
   *  `[organization_id]`. */
  async sumForOrganizationSince(
    organizationId: string,
    since: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const agg = await tx.ciLiveAccrual.aggregate({
      where: { organizationId, tickStart: { gte: since } },
      _sum: { accruedSeconds: true },
    });
    return agg._sum.accruedSeconds ?? 0;
  },

  /** The DISTINCT organisations that accrued anything in ticks starting at or
   *  after `since` — so the fleet monitor also sees an org being debited while
   *  nothing of its runs (MOTIR-7316). Ids only. */
  async listOrganizationsSince(since: Date, tx: Prisma.TransactionClient): Promise<string[]> {
    const rows = await tx.ciLiveAccrual.findMany({
      where: { tickStart: { gte: since } },
      distinct: ['organizationId'],
      select: { organizationId: true },
    });
    return rows.map((row) => row.organizationId);
  },

  /** The start of the latest tick that accrued anything for one organisation, or
   *  null — the fleet monitor's "is the debit job reaching this org?". */
  async latestTickForOrganization(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Date | null> {
    const agg = await tx.ciLiveAccrual.aggregate({
      where: { organizationId },
      _max: { tickStart: true },
    });
    return agg._max.tickStart ?? null;
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
