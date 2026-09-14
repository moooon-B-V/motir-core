import type { Prisma } from '@/generated/prisma/client';

// Single-op data access for `test_instructions_repo` — one REPOSITORY SECTION of
// a run's HOW TO TEST record (Story MOTIR-4906 · Subtask MOTIR-5328). Named for
// its entity, not for its only caller (the 4-layer rule): the record's own
// repository never writes this table.

/** The create payload, named here so callers above never spell the Prisma type. */
export type TestInstructionsRepoCreateInput = Prisma.TestInstructionsRepoCreateManyInput;

export const testInstructionsRepoRepository = {
  /** Insert every section of one record in one statement. Returns the count. */
  async createMany(
    rows: readonly TestInstructionsRepoCreateInput[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const result = await tx.testInstructionsRepo.createMany({ data: [...rows] });
    return result.count;
  },
};
