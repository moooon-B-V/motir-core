import type { Prisma, RunFoundReport, RunFoundReportOutcome } from '@/generated/prisma/client';

// The RUN-FOUND REPORT's filing rows (MOTIR-5544 · MOTIR-6282) — single Prisma
// operations on `run_found_report`. The report SERVICE owns every decision
// (which arm, whether to file, what to record) and the transaction; this leaf
// holds none of that. `docs/decisions/run-found-trigger-dispatched-path.md`,
// *Idempotency*, is the record.
//
// ⚠️ CLAIM-OR-LOCK IS TWO OPERATIONS, AND THE ORDER IS THE MECHANISM — the
// `jobDlqStandingFilingRepository` shape, mirrored rather than re-invented:
//
//   1. `insertIfAbsent` — `INSERT … ON CONFLICT DO NOTHING` on the unique
//      `dispatch_run_card_id`. A concurrent report's insert BLOCKS on the first
//      one's uncommitted row until it commits, then does nothing.
//   2. `lockByLegId` — `SELECT … FOR UPDATE` on the row that now exists. The
//      loser waits for the winner's whole transaction — the bug's creation
//      included — then reads the recorded `outcome` and files nothing.
//
// Every method is called under `withSystemContext`: the table's only RLS arm is
// `app.system_admin`, because the row is Motir's record, not the tenant's.

export const runFoundReportRepository = {
  /** Insert an UNDECIDED row (no `outcome`) for the leg unless one exists.
   *  Returns whether THIS call inserted it — informational only; the caller
   *  decides from the LOCKED row. */
  async insertIfAbsent(
    dispatchRunCardId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const result = await tx.runFoundReport.createMany({
      data: [{ dispatchRunCardId, workspaceId }],
      skipDuplicates: true,
    });
    return result.count === 1;
  },

  /** Lock the leg's row `FOR UPDATE` and return its id, or null when there is
   *  none. Blocks while another transaction holds it — which is the point. The
   *  caller re-reads through {@link findById} in the SAME transaction. */
  async lockByLegId(
    dispatchRunCardId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM run_found_report WHERE dispatch_run_card_id = ${dispatchRunCardId} FOR UPDATE`;
    return rows[0]?.id ?? null;
  },

  /** One row by id — the re-read under the lock above. */
  async findById(id: string, tx: Prisma.TransactionClient): Promise<RunFoundReport | null> {
    return tx.runFoundReport.findUnique({ where: { id } });
  },

  /** Record how the report concluded, and the bug filed on `filed`. */
  async markOutcome(
    id: string,
    input: {
      outcome: RunFoundReportOutcome;
      filedWorkItemId?: string | null;
      filedWorkItemIdentifier?: string | null;
    },
    tx: Prisma.TransactionClient,
  ): Promise<RunFoundReport> {
    return tx.runFoundReport.update({
      where: { id },
      data: {
        outcome: input.outcome,
        filedWorkItemId: input.filedWorkItemId ?? null,
        filedWorkItemIdentifier: input.filedWorkItemIdentifier ?? null,
      },
    });
  },
};
