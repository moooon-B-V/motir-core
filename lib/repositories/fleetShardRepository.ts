import type {
  FleetShard,
  FleetShardPauseReason,
  FleetShardRole,
  FleetShardState,
  Prisma,
} from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';

// Data access for the FLEET ACCOUNT RECORD (Story MOTIR-8953 · MOTIR-8961) —
// one row per account of one fleet kind's pool. The table's policy is
// `app.system_admin` only, so the caller holds a `withSystemContext` transaction.

export type FleetShardCreateInput = Prisma.FleetShardUncheckedCreateInput;

/** The four limit columns, as one write. */
export interface FleetShardLimits {
  vcpuQuota: number | null;
  machineLimit: number | null;
  githubRegistrationsPer5Min: number | null;
  githubApiPerHour: number | null;
}

export const fleetShardRepository = {
  async create(data: FleetShardCreateInput, tx: Prisma.TransactionClient): Promise<FleetShard> {
    return tx.fleetShard.create({ data });
  },

  async findById(id: string, tx?: Prisma.TransactionClient): Promise<FleetShard | null> {
    const client = tx ?? dbRead;
    return client.fleetShard.findUnique({ where: { id } });
  },

  async findByName(name: string, tx?: Prisma.TransactionClient): Promise<FleetShard | null> {
    const client = tx ?? dbRead;
    return client.fleetShard.findUnique({ where: { name } });
  },

  /** One role's accounts, optionally of one kind and in one state — oldest first. */
  async listByRole(
    role: FleetShardRole,
    filter: { fleetKind?: string; state?: FleetShardState },
    tx?: Prisma.TransactionClient,
  ): Promise<FleetShard[]> {
    const client = tx ?? dbRead;
    return client.fleetShard.findMany({
      where: {
        role,
        ...(filter.fleetKind !== undefined ? { fleetKind: filter.fleetKind } : {}),
        ...(filter.state !== undefined ? { state: filter.state } : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  },

  async updateLimits(
    id: string,
    limits: FleetShardLimits,
    source: Prisma.InputJsonValue,
    verifiedAt: Date,
    tx: Prisma.TransactionClient,
  ): Promise<FleetShard> {
    return tx.fleetShard.update({
      where: { id },
      data: { ...limits, limitsSource: source, limitsVerifiedAt: verifiedAt },
    });
  },

  async updateState(
    id: string,
    state: FleetShardState,
    tx: Prisma.TransactionClient,
  ): Promise<FleetShard> {
    return tx.fleetShard.update({ where: { id }, data: { state } });
  },

  /** The ACTIVE accounts of one fleet kind's shared pool, with their pause and
   *  override columns — admission's candidates (MOTIR-8968). Read uncached on
   *  every admission, so an override or a pause takes effect on the next job. */
  async listActiveForKindInTx(
    fleetKind: string,
    tx: Prisma.TransactionClient,
  ): Promise<FleetShard[]> {
    return tx.fleetShard.findMany({
      where: { fleetKind, role: 'primary', state: 'active' },
      orderBy: { id: 'asc' },
    });
  },

  /** Skip this account in admission until `until` (MOTIR-8968). */
  async pauseInTx(
    id: string,
    until: Date,
    reason: FleetShardPauseReason,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.fleetShard.update({
      where: { id },
      data: { admissionPausedUntil: until, admissionPausedReason: reason },
    });
  },
};
