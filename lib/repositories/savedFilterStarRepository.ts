import type { Prisma, SavedFilterStar } from '@prisma/client';

// Saved-filter star data access (Story 6.2 · Subtask 6.2.1). Single Prisma
// ops; writes require `tx` (CLAUDE.md). Counts live in the parent read's
// `_count` aggregation (savedFilterRepository) — this repo owns only the
// star rows themselves.

export const savedFilterStarRepository = {
  /** The star/unstar existence read — a validation read that gates a write,
   * so it runs inside the write's transaction (required `tx`, CLAUDE.md). */
  async findByFilterAndUser(
    savedFilterId: string,
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<SavedFilterStar | null> {
    return tx.savedFilterStar.findUnique({
      where: { savedFilterId_userId: { savedFilterId, userId } },
    });
  },

  async create(
    data: Prisma.SavedFilterStarUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<SavedFilterStar> {
    return tx.savedFilterStar.create({ data });
  },

  /** Idempotent unstar — returns the number of rows removed (0 or 1). */
  async deleteByFilterAndUser(
    savedFilterId: string,
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const r = await tx.savedFilterStar.deleteMany({ where: { savedFilterId, userId } });
    return r.count;
  },
};
