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
// ⚠️ WRITE ONLY, and that is the card's boundary rather than an oversight
// (MOTIR-3535): the READ path, its DTO and the surface that renders it belong to
// the sibling card. A trail nothing reads yet is still a trail that must be
// correct from its first row, because the rows it misses cannot be recovered
// later.
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
};
