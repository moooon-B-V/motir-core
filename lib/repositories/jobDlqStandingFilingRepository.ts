import type { JobDlqStandingFiling, Prisma } from '@/generated/prisma/client';

// The DLQ standing-depth filer's dedup rows (MOTIR-5869) — single Prisma
// operations on `job_dlq_standing_filing`. The service owns every decision (file,
// skip, re-arm) and the transaction; this leaf holds none of that.
//
// ⚠️ CLAIM-OR-LOCK IS TWO OPERATIONS, AND THE ORDER IS THE MECHANISM — the
// `monitorIssueRepository` shape, mirrored rather than re-invented:
//
//   1. `insertIfAbsent` — `INSERT … ON CONFLICT DO NOTHING` on the unique
//      `function_id`. A concurrent claimant's insert BLOCKS on the first one's
//      uncommitted row until it commits, then does nothing.
//   2. `lockByFunctionId` — `SELECT … FOR UPDATE` on the row that now exists.
//      The loser waits for the winner's whole transaction — the bug's creation
//      included — then reads `armed = false` and files nothing.
//
// Every method is called under `withSystemContext`: the table's only RLS arm is
// `app.system_admin`.

export const jobDlqStandingFilingRepository = {
  /** Insert an ARMED row for the function unless one exists. Returns whether
   *  THIS call inserted it — informational only; the caller decides from the
   *  LOCKED row. */
  async insertIfAbsent(functionId: string, tx: Prisma.TransactionClient): Promise<boolean> {
    const result = await tx.jobDlqStandingFiling.createMany({
      data: [{ functionId }],
      skipDuplicates: true,
    });
    return result.count === 1;
  },

  /** Lock the function's row `FOR UPDATE` and return its id, or null when there
   *  is none. Blocks while another transaction holds it — which is the point.
   *  The caller re-reads through {@link findById} in the SAME transaction. */
  async lockByFunctionId(functionId: string, tx: Prisma.TransactionClient): Promise<string | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM job_dlq_standing_filing WHERE function_id = ${functionId} FOR UPDATE`;
    return rows[0]?.id ?? null;
  },

  /** One row by id — the re-read under the lock above. */
  async findById(id: string, tx: Prisma.TransactionClient): Promise<JobDlqStandingFiling | null> {
    return tx.jobDlqStandingFiling.findUnique({ where: { id } });
  },

  /** Every DISARMED row — a function filed for and not yet re-armed. */
  async listDisarmed(tx: Prisma.TransactionClient): Promise<JobDlqStandingFiling[]> {
    return tx.jobDlqStandingFiling.findMany({ where: { armed: false } });
  },

  /** Record the bug just filed and DISARM the row. */
  async markFiled(
    id: string,
    identifier: string,
    at: Date,
    tx: Prisma.TransactionClient,
  ): Promise<JobDlqStandingFiling> {
    return tx.jobDlqStandingFiling.update({
      where: { id },
      data: { armed: false, filedWorkItemIdentifier: identifier, filedAt: at },
    });
  },

  /**
   * RE-ARM every disarmed row among these functions — the ones whose standing
   * depth the caller just read as ZERO. `armed: false` stays in the predicate so
   * a row another sweep re-armed in between is not stamped twice. Returns the
   * number re-armed.
   */
  async rearm(functionIds: string[], at: Date, tx: Prisma.TransactionClient): Promise<number> {
    if (functionIds.length === 0) return 0;
    const result = await tx.jobDlqStandingFiling.updateMany({
      where: { functionId: { in: functionIds }, armed: false },
      data: { armed: true, rearmedAt: at },
    });
    return result.count;
  },
};
