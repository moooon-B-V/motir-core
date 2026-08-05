import { Prisma, type PlanChangeTurn, type PlanChangeTurnRole } from '@prisma/client';
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

  /** The `assistant` turn a given job already produced on this session, if any —
   *  the IDEMPOTENCY read behind "one planning job, at most one planner turn"
   *  (MOTIR-2226). The client records the turn when its stream settles, and a
   *  reload, a second tab or a retried read all replay that call; keying on the
   *  job makes every replay a no-op instead of a duplicate bubble. Takes `tx`
   *  because it guards a write and must be read UNDER the session's row lock. */
  async findByJobIdAndRole(
    sessionId: string,
    jobId: string,
    role: PlanChangeTurnRole,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeTurn | null> {
    return tx.planChangeTurn.findFirst({ where: { sessionId, workspaceId, jobId, role } });
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
