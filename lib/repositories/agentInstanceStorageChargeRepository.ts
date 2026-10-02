import type {
  AgentInstanceChargeOutcome,
  AgentInstanceStorageCharge,
  Prisma,
} from '@/generated/prisma/client';

// Single Prisma operations on `agent_instance_storage_charge` — one UTC day of
// an agent instance's storage, the unit it is charged in (Story MOTIR-6914 ·
// MOTIR-6919, `docs/decisions/agent-instance-storage.md` §2).
//
// Every method takes `tx`, reads included, for `agentInstanceRepository`'s
// reason (RLS on `app.workspace_id`; a bare read returns an empty list).
//
// ⚠️ TWO GUARDS HERE ARE THE BILLING INVARIANTS:
//   * a day is WRITTEN once — `charge_reference` is unique and `createDays`
//     skips a duplicate, so a re-run of the daily charge adds nothing;
//   * a charge is RECORDED once — `recordCharge` writes only onto a row still
//     `pending`, so a replayed charge cannot overwrite a decided one.

/** One day to charge, named here so callers above never spell a Prisma input type. */
export interface AgentInstanceStorageDayInput {
  workspaceId: string;
  organizationId: string;
  agentInstanceId: string;
  /** Midnight UTC of the day charged. */
  day: Date;
  credits: number;
  chargeReference: string;
}

/** What a charge attempt writes back. */
export interface AgentInstanceStorageChargeInput {
  outcome: AgentInstanceChargeOutcome;
  detail?: string | null;
  chargedAt?: Date | null;
}

export const agentInstanceStorageChargeRepository = {
  /**
   * Write the days to charge, `pending`, skipping any already written. `tx`
   * required — a write. Returns how many were new.
   */
  async createDays(
    rows: readonly AgentInstanceStorageDayInput[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const result = await tx.agentInstanceStorageCharge.createMany({
      data: rows.map((r) => ({ ...r })),
      skipDuplicates: true,
    });
    return result.count;
  },

  /** Rows still `pending`, oldest day first — the charge pass's discovery. */
  async listPending(
    take: number,
    tx: Prisma.TransactionClient,
  ): Promise<AgentInstanceStorageCharge[]> {
    return tx.agentInstanceStorageCharge.findMany({
      where: { chargeOutcome: 'pending' },
      orderBy: [{ day: 'asc' }, { id: 'asc' }],
      take,
    });
  },

  /**
   * Write a charge attempt's outcome — only onto a row still `pending`. Counts
   * the attempt either way it lands. Returns `1` for the write that won.
   */
  async recordCharge(
    id: string,
    data: AgentInstanceStorageChargeInput,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.agentInstanceStorageCharge.updateMany({
      where: { id, chargeOutcome: 'pending' },
      data: {
        chargeOutcome: data.outcome,
        chargeAttempts: { increment: 1 },
        ...(data.detail !== undefined ? { chargeDetail: data.detail } : {}),
        ...(data.chargedAt !== undefined ? { chargedAt: data.chargedAt } : {}),
      },
    });
    return result.count;
  },

  /** One charged day as the platform meter report needs it (MOTIR-7294). */
  async findForMeterReport(id: string, tx: Prisma.TransactionClient) {
    return tx.agentInstanceStorageCharge.findUnique({
      where: { id },
      select: {
        id: true,
        workspaceId: true,
        organizationId: true,
        agentInstanceId: true,
        day: true,
        chargeOutcome: true,
      },
    });
  },

  /**
   * The next CHARGED days motir-ai's rollup has not accepted yet, in id order after
   * `afterId` — one bounded batch of the backfill (MOTIR-7294).
   */
  async listUnreportedCharged(afterId: string | null, take: number, tx: Prisma.TransactionClient) {
    return tx.agentInstanceStorageCharge.findMany({
      where: {
        chargeOutcome: 'charged',
        platformMeterReportedAt: null,
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      orderBy: { id: 'asc' },
      take,
      select: { id: true, workspaceId: true },
    });
  },

  /** Stamp a day's report as accepted. Only the first stamp lands. */
  async markMeterReported(id: string, at: Date, tx: Prisma.TransactionClient): Promise<number> {
    const result = await tx.agentInstanceStorageCharge.updateMany({
      where: { id, platformMeterReportedAt: null },
      data: { platformMeterReportedAt: at },
    });
    return result.count;
  },
};
