import type {
  GateResume,
  GateResumeOutcome,
  GateResumeSkipReason,
  Prisma,
} from '@/generated/prisma/client';

// THE AUTOMATIC-RESUME RECORD (Story MOTIR-7701 · MOTIR-7710) — one row per approved
// gate a `gated` hosted run held, keyed on the gate. `designAutoRerunRepository`'s
// shape, one decision over. Writes require `tx` (the 4-layer rule).

export interface GateResumeCreateInput {
  workspaceId: string;
  gateId: string;
  runId: string;
  resumedRunId: string | null;
  outcome: GateResumeOutcome;
  skipReason: GateResumeSkipReason | null;
  /** What the skipped line names — see the column's note. */
  detail: string | null;
}

export const gateResumeRepository = {
  /** The attempt an approval already produced, if any — the job's idempotency read. */
  async findByGateId(gateId: string, tx: Prisma.TransactionClient): Promise<GateResume | null> {
    return tx.gateResume.findUnique({ where: { gateId } });
  },

  /** Record an attempt. `tx` required — a write. */
  async create(data: GateResumeCreateInput, tx: Prisma.TransactionClient): Promise<GateResume> {
    return tx.gateResume.create({ data });
  },

  /** Several runs' attempts, newest first — the To resume entries' line. */
  async listByRunIds(runIds: string[], tx: Prisma.TransactionClient): Promise<GateResume[]> {
    if (runIds.length === 0) return [];
    return tx.gateResume.findMany({
      where: { runId: { in: runIds } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  },
};
