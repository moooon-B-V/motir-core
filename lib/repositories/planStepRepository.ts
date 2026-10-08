import type { Prisma, PlanStep, PlanStepKind } from '@/generated/prisma/client';

/**
 * What a step write carries, NAMED BY THE OWNING REPOSITORY (MOTIR-4296) —
 * callers build against this, never against a generated projection type.
 */
export interface PlanStepWriteInput {
  kind: PlanStepKind;
  targetRef: string | null;
  startedAt: Date;
}

// Plan-step repository — single Prisma operations on the `plan_step` table
// (Story MOTIR-7820 · Subtask MOTIR-7822): the step each RUNNING planner session
// is on, one row per `(planId, sessionKey)`. No business logic, no transactions,
// no DTO mapping — `plansService` owns those.
//
// ⚠️ EVERY READ TAKES A REQUIRED `tx`, for the reason `planRevisionRepository`
// gives for its own: `plan_step` has no `workspace_id` of its own — its policy
// JOINS to the parent `plan` — so an UNBOUND read through the `db` singleton
// matches nothing rather than failing, and an empty step set reads exactly like
// "nobody is working on this plan". Requiring the bound transaction makes the
// binding a compile-time obligation.
export const planStepRepository = {
  /**
   * Record a session's step, REPLACING the one it reported before (the unique
   * `(planId, sessionKey)` key). Returns the row as stored.
   */
  async upsertForSession(
    planId: string,
    sessionKey: string,
    data: PlanStepWriteInput,
    tx: Prisma.TransactionClient,
  ): Promise<PlanStep> {
    return tx.planStep.upsert({
      where: { planId_sessionKey: { planId, sessionKey } },
      create: { planId, sessionKey, ...data },
      update: data,
    });
  },

  /** Clear a session's step. Returns how many rows went (0 or 1). */
  async deleteForSession(
    planId: string,
    sessionKey: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const r = await tx.planStep.deleteMany({ where: { planId, sessionKey } });
    return r.count;
  },

  /** One plan's steps, oldest first. */
  async listByPlan(planId: string, tx: Prisma.TransactionClient): Promise<PlanStep[]> {
    return tx.planStep.findMany({
      where: { planId },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
    });
  },

  /** Many plans' steps in ONE query, oldest first — the batch read a list of
   *  generating plans needs so it never reads per row. */
  async listByPlanIds(
    planIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<PlanStep[]> {
    if (planIds.length === 0) return [];
    return tx.planStep.findMany({
      where: { planId: { in: [...planIds] } },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
    });
  },
};
