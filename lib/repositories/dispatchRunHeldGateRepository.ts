import type { ApprovalGateKind, DispatchRunHeldGate, Prisma } from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';

// THE HELD-GATE RECORD (Story MOTIR-7701 · MOTIR-7703;
// `docs/decisions/dispatch-run-record.md` AMENDMENT 2026-10-07) — one row per
// approval gate a run stopped at when it closed `gated`. Written by the close
// itself (`dispatchRunService.closeWithin`), read by To resume and the
// auto-resume. Writes require `tx` (the 4-layer rule).

export interface DispatchRunHeldGateCreateInput {
  workspaceId: string;
  dispatchRunId: string;
  gateId: string;
  workItemId: string;
  kind: ApprovalGateKind;
}

export const dispatchRunHeldGateRepository = {
  /** Record the gates a run stopped at. `tx` required — a write. Idempotent per `(run, gate)`. */
  async createMany(
    rows: DispatchRunHeldGateCreateInput[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const r = await tx.dispatchRunHeldGate.createMany({ data: rows, skipDuplicates: true });
    return r.count;
  },

  /** A run's held gates, in the order they were recorded. */
  async listByRun(
    dispatchRunId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<DispatchRunHeldGate[]> {
    const client = tx ?? dbRead;
    return client.dispatchRunHeldGate.findMany({
      where: { dispatchRunId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  },

  /** The runs a gate held — the decide door's read. */
  async listByGate(gateId: string, tx?: Prisma.TransactionClient): Promise<DispatchRunHeldGate[]> {
    const client = tx ?? dbRead;
    return client.dispatchRunHeldGate.findMany({
      where: { gateId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  },
};
