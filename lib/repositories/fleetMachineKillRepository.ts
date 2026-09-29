import type { FleetMachineKill, Prisma } from '@/generated/prisma/client';

// Data access for the KILL RECORD (Story MOTIR-6906 · MOTIR-6925,
// `docs/decisions/fleet-per-org-pool.md` §5) — one row per machine the
// attribution reconciler destroyed or stopped. The table's policy is
// `app.system_admin` only, so every method takes the transaction.

export interface FleetMachineKillCreateInput {
  app: string;
  machineId: string;
  machineName: string;
  reason: string;
  action: string;
  workload: string | null;
  recordRef: string | null;
  organizationId: string | null;
  machineCreatedAt: Date | null;
  ageSeconds: number;
  decidedAt: Date;
}

export const fleetMachineKillRepository = {
  /** Record the DECISION — before the provider is asked to act on it. */
  async create(
    data: FleetMachineKillCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<FleetMachineKill> {
    return tx.fleetMachineKill.create({ data });
  },

  /** The provider carried it out. */
  async markCompleted(id: string, at: Date, tx: Prisma.TransactionClient): Promise<void> {
    await tx.fleetMachineKill.update({ where: { id }, data: { completedAt: at } });
  },

  /** The provider refused; the next pass decides again. */
  async markFailed(id: string, detail: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.fleetMachineKill.update({ where: { id }, data: { failureDetail: detail } });
  },
};
