import { Prisma, type PlanChangeTurn } from '@prisma/client';
import { db } from '@/lib/db';

// Single Prisma operations on the `plan_change_turn` table (Story 7.30 ·
// MOTIR-1728). Its own repository, not a corner of the session's: the entity
// name wins over the call site (the 4-layer repository-naming rule). Writes
// require `tx`; the thread read takes an optional `tx` so an append can return
// the freshly-extended thread from inside its own transaction.
export const planChangeTurnRepository = {
  async create(
    data: Prisma.PlanChangeTurnUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeTurn> {
    return tx.planChangeTurn.create({ data });
  },

  /** The session's FULL thread in `seq` order — the ordering contract every
   *  consumer (the resume payload, the accumulated intent) depends on, applied
   *  here ONCE rather than at each call site. Workspace-scoped: a session id from
   *  another tenant yields an empty thread. */
  async listBySessionId(
    sessionId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<PlanChangeTurn[]> {
    const client = tx ?? db;
    return client.planChangeTurn.findMany({
      where: { sessionId, workspaceId },
      orderBy: { seq: 'asc' },
    });
  },
};
