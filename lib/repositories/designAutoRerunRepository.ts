import type {
  DesignAutoRerun,
  DesignAutoRerunOutcome,
  DesignAutoRerunSkipReason,
  Prisma,
} from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';

// THE AUTOMATIC-RE-RUN RECORD (Story MOTIR-693 · MOTIR-700;
// `docs/decisions/hosted-design-rerun-and-design-approval-switch.md` §1g) — one row
// per design Revise that was a candidate, keyed on the deciding gate.

export interface DesignAutoRerunCreateInput {
  workspaceId: string;
  workItemId: string;
  gateId: string;
  outcome: DesignAutoRerunOutcome;
  skipReason: DesignAutoRerunSkipReason | null;
  dispatchRunId: string | null;
  ordinal: number;
  /** What the skipped line names — see the column's note. */
  detail: string | null;
}

export const designAutoRerunRepository = {
  /** The attempt a refusal already produced, if any — the job's idempotency read. */
  async findByGateId(
    gateId: string,
    tx: Prisma.TransactionClient,
  ): Promise<DesignAutoRerun | null> {
    return tx.designAutoRerun.findUnique({ where: { gateId } });
  },

  /** Record an attempt. `tx` required — a write. */
  async create(
    data: DesignAutoRerunCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<DesignAutoRerun> {
    return tx.designAutoRerun.create({ data });
  },

  /** A card's attempts, newest first — the design card's line (MOTIR-702). */
  async listByWorkItem(
    workItemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<DesignAutoRerun[]> {
    const client = tx ?? dbRead;
    return client.designAutoRerun.findMany({
      where: { workItemId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  },
};
