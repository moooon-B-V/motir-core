import type { Prisma, PlanRevision } from '@/generated/prisma/client';

// Plan-revision repository — single Prisma operations on the `plan_revision`
// table (Story MOTIR-3532 · Subtask MOTIR-3535). The append-only leaf the plan
// write flows persist through: `plansService` records a revision via
// `planRevisionsService.recordRevision`, which calls `create` here INSIDE the
// same transaction as the mutation it describes.
//
// Layer rules (CLAUDE.md): the write REQUIRES `tx`, so a revision can only be
// written inside a transaction — that is the compile-time half of the atomicity
// guarantee (a revision commits with its mutation, or neither does). No business
// logic, no transactions, no DTO mapping here.
//
// ⚠️ THE READ TAKES A REQUIRED `tx` TOO, and that is not the usual call for a
// pure read path. `plan_revision` has no `workspace_id` of its own — its policy
// JOINS to the parent `plan` — so an UNBOUND read through the `db` singleton
// matches nothing at all rather than failing: the GUC is unset, the policy's
// predicate is NULL, and `findMany` returns an empty trail on a plan that has
// one. That is the worst shape a tenant read can take, because an empty history
// looks exactly like a plan nobody has touched. Requiring the transaction makes
// the binding a compile-time obligation rather than a thing to remember, the
// same way the write's `tx` does. (Measured: the first draft used `db`, and every
// content event silently vanished from the timeline.)
//
// The read arrived with the surface (MOTIR-3536), one card after the write — the
// trail had to be correct from its first row before anything read it, because the
// rows it misses cannot be recovered later.
//
// No error translation: the table has no triggers, and a cross-workspace write
// attempt is caught by the RLS policy's WITH CHECK (42501) rather than by
// anything this layer needs to interpret.

export const planRevisionRepository = {
  /**
   * Insert one revision row. Required `tx` — a revision MUST commit atomically
   * with the plan mutation it describes. Uses the unchecked create input so the
   * caller passes scalar foreign keys (`planId` / `planItemId` / `changedById`)
   * directly rather than nested `connect` wrappers; the service already holds
   * the ids.
   */
  async create(
    data: Prisma.PlanRevisionUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<PlanRevision> {
    return tx.planRevision.create({ data });
  },

  /**
   * One plan's whole trail, OLDEST FIRST — the order the timeline reads in
   * (MOTIR-3536).
   *
   * ⚠️ ONE query for the whole history, deliberately: the plan review model is
   * re-read on every poll of a `generating` plan, and a plan whose trail is a row
   * per proposal would otherwise cost a round trip per row on the surface that
   * polls hardest. It walks the `(plan_id, changed_at)` index end to end.
   *
   * Unbounded, and that is a decision rather than an omission. A trail is bounded
   * by the plan's own authoring — six sites, one row each, plus one per proposal
   * deepened — so it is tens of rows, not thousands, and truncating it would make
   * the timeline silently lie about the one thing it exists to say. If a plan
   * ever grows a trail worth paginating, the pagination belongs on the surface
   * that renders it, where the reader can be told what is not shown.
   */
  async listByPlan(planId: string, tx: Prisma.TransactionClient): Promise<PlanRevision[]> {
    return tx.planRevision.findMany({ where: { planId }, orderBy: { changedAt: 'asc' } });
  },
};
