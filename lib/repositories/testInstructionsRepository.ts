import type { Prisma, TestInstructions } from '@/generated/prisma/client';

// Single-op data access for the `test_instructions` table — the HOW TO TEST
// record (Story MOTIR-4906 · Subtask MOTIR-5328). Writes require `tx` (the
// 4-layer rule), and so do the reads: every caller is inside
// withWorkspaceContext, which binds the `app.workspace_id` GUC the table's pure
// active-workspace RLS policy reads (the `design_evidence` shape).
//
// ⚠️ The card sketched one `insertCurrent` that "clears the previous current row,
// then inserts". That is TWO operations, so it is two methods here —
// {@link markNotCurrentByPair} and {@link create} — composed by the service
// under the lock it takes. A repository method that did both would own an
// ordering the single-op rule reserves for the service.

/** The create payload, named here so callers above never spell the Prisma type. */
export type TestInstructionsCreateInput = Prisma.TestInstructionsUncheckedCreateInput;

export const testInstructionsRepository = {
  async create(
    data: TestInstructionsCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<TestInstructions> {
    return tx.testInstructions.create({ data });
  },

  /**
   * Clear the one-current slot for a (work item, repository) pair — the first
   * half of a new version. The caller holds the item's row lock, so nothing can
   * take the slot between this and the insert. Returns the affected count.
   */
  async markNotCurrentByPair(
    workItemId: string,
    repoId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.testInstructions.updateMany({
      where: { workItemId, repoId, isCurrent: true },
      data: { isCurrent: false },
    });
    return result.count;
  },

  /**
   * The NEWEST record written for one commit of one pair, current or not — the
   * idempotency read. A retried publish of identical content finds its own
   * earlier row here and writes nothing.
   */
  async findLatestByCommit(
    workItemId: string,
    repoId: string,
    commitSha: string,
    tx: Prisma.TransactionClient,
  ): Promise<TestInstructions | null> {
    return tx.testInstructions.findFirst({
      where: { workItemId, repoId, commitSha },
      orderBy: { createdAt: 'desc' },
    });
  },

  /** Every CURRENT record for one work item — one per repository. */
  async listCurrentByWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<TestInstructions[]> {
    return tx.testInstructions.findMany({
      where: { workItemId, isCurrent: true },
      orderBy: { createdAt: 'asc' },
    });
  },

  /**
   * Every CURRENT record for a BATCH of work items, in ONE query — the read
   * behind a page that renders several cards' blocks (MOTIR-5333). An empty
   * batch short-circuits without a round trip.
   */
  async listCurrentByWorkItems(
    workItemIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<TestInstructions[]> {
    if (workItemIds.length === 0) return [];
    return tx.testInstructions.findMany({
      where: { workItemId: { in: [...workItemIds] }, isCurrent: true },
      orderBy: { createdAt: 'asc' },
    });
  },
};
