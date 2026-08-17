import { Prisma, type PlanTargetLock } from '@/generated/prisma/client';

// Single Prisma operations on the `plan_target_lock` table (Story MOTIR-2786 ·
// MOTIR-2787) — the lease behind the `planning` status lock. No business logic,
// no transactions, no DTO mapping; those belong in `planTargetLockService`.
//
// ⚠️ EVERY method takes a REQUIRED `tx`, reads included — unusually for this
// layer, and on purpose. There is no such thing as an unbound read here: an
// acquire's read guards a write in the same transaction, the release's read
// guards a status restore, and the sweep's read runs inside the system-context
// transaction that then re-binds per row. A `tx ?? db` arm would have no caller
// at all, which is how a repository file loses branch coverage against its 90%
// gate the moment the last test call site binds.
export const planTargetLockRepository = {
  async create(
    data: Prisma.PlanTargetLockUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<PlanTargetLock> {
    return tx.planTargetLock.create({ data });
  },

  /** The lease on ONE work item, or null. The acquire path's decision read — run
   *  AFTER the work item's own row lock, so what it returns cannot move under
   *  the caller. */
  async findByWorkItemId(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanTargetLock | null> {
    return tx.planTargetLock.findUnique({ where: { workItemId } });
  },

  /** Every lease ONE session holds. The release read. Ordered by work item id so
   *  a release takes its row locks in the same order an acquire does — two
   *  operations touching the same pair of items in opposite orders is a
   *  deadlock, not a queue. */
  async listBySessionId(
    sessionId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanTargetLock[]> {
    return tx.planTargetLock.findMany({
      where: { sessionId },
      orderBy: { workItemId: 'asc' },
    });
  },

  async update(
    id: string,
    data: Prisma.PlanTargetLockUncheckedUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<PlanTargetLock> {
    return tx.planTargetLock.update({ where: { id }, data });
  },

  async deleteById(id: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.planTargetLock.delete({ where: { id } });
  },

  /** Push every lease a session holds out to a new expiry — the heartbeat. One
   *  statement, because a refresh has no per-row decision to make. Returns how
   *  many rows moved, so a caller can tell "refreshed nothing" from "refreshed
   *  the set". */
  async extendBySessionId(
    sessionId: string,
    expiresAt: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.planTargetLock.updateMany({
      where: { sessionId },
      data: { expiresAt },
    });
    return result.count;
  },

  /**
   * The sweep's discovery read: leases whose window has run out, oldest first,
   * bounded.
   *
   * CROSS-TENANT BY DESIGN — it runs under `withSystemContext`, which is why the
   * table carries a `FOR SELECT` `app.system_admin` policy arm. Without the arm
   * this returns zero rows and raises nothing, and for a sweep an empty result is
   * indistinguishable from "nothing has expired": the vacuous pass.
   */
  async listExpired(
    now: Date,
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<PlanTargetLock[]> {
    return tx.planTargetLock.findMany({
      where: { expiresAt: { lte: now } },
      orderBy: { expiresAt: 'asc' },
      take: limit,
    });
  },
};
