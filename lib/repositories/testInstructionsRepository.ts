import type { Prisma, TestInstructions, TestInstructionsRepo } from '@/generated/prisma/client';

// Single-op data access for the `test_instructions` table — the HOW TO TEST
// record, one per RUN on the run target (Story MOTIR-4906 · Subtask MOTIR-5328;
// `docs/decisions/approval-gates.md` §9's 2026-09-13 amendment). Writes require
// `tx` (the 4-layer rule), and so do the reads: every caller is inside
// withWorkspaceContext, which binds the `app.workspace_id` GUC the table's pure
// active-workspace RLS policy reads (the `design_evidence` shape).
//
// Reads include the record's repository sections in the SAME query (a Prisma
// `include` is one round trip per relation level, independent of row count).

/** The create payload, named here so callers above never spell the Prisma type. */
export type TestInstructionsCreateInput = Prisma.TestInstructionsUncheckedCreateInput;

/** A record row with its repository sections, as every read here returns it. */
export type TestInstructionsWithRepos = TestInstructions & { repos: TestInstructionsRepo[] };

const WITH_REPOS = { repos: { orderBy: { position: 'asc' } } } as const;

export const testInstructionsRepository = {
  async insert(
    data: TestInstructionsCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string }> {
    return tx.testInstructions.create({ data, select: { id: true } });
  },

  /**
   * Clear the one-current slot for a run target — the first half of a new
   * version. The caller holds the item's row lock, so nothing can take the slot
   * between this and the insert. Returns the affected count.
   */
  async clearCurrent(workItemId: string, tx: Prisma.TransactionClient): Promise<number> {
    const result = await tx.testInstructions.updateMany({
      where: { workItemId, isCurrent: true },
      data: { isCurrent: false },
    });
    return result.count;
  },

  /** One record by id, with its sections. */
  async findById(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<TestInstructionsWithRepos | null> {
    return tx.testInstructions.findUnique({ where: { id }, include: WITH_REPOS });
  },

  /** The CURRENT record for one run target, with its sections — the idempotency read. */
  async findCurrentForWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<TestInstructionsWithRepos | null> {
    return tx.testInstructions.findFirst({
      where: { workItemId, isCurrent: true },
      include: WITH_REPOS,
    });
  },

  /**
   * Every CURRENT record for a BATCH of run targets, with sections, in a
   * batch-size-independent number of queries — the read behind a page that
   * renders several items' blocks (MOTIR-5333). An empty batch short-circuits.
   */
  async listCurrentByWorkItems(
    workItemIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<TestInstructionsWithRepos[]> {
    if (workItemIds.length === 0) return [];
    return tx.testInstructions.findMany({
      where: { workItemId: { in: [...workItemIds] }, isCurrent: true },
      include: WITH_REPOS,
      orderBy: { createdAt: 'asc' },
    });
  },

  /** Every record ever written for one run target, newest first — the earlier runs. */
  async listHistoryForWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<TestInstructionsWithRepos[]> {
    return tx.testInstructions.findMany({
      where: { workItemId },
      include: WITH_REPOS,
      orderBy: { createdAt: 'desc' },
    });
  },
};
