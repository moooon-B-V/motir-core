import { type Import, type Prisma } from '@prisma/client';
import { db } from '@/lib/db';

// Import repository — single Prisma operations on the `import` RUN table
// (Story 7.16 · MOTIR-939). Per CLAUDE.md: write methods require
// `tx: Prisma.TransactionClient`; pure reads may use the `db` singleton (an
// optional `tx` joins a surrounding transaction). NO business logic, NO
// transactions, NO DTO mapping here — the mapping/persist engine (MOTIR-941)
// owns the transaction + the create-vs-update decision; this leaf just reads
// and writes the row.
export const importRepository = {
  /** Create an import RUN row. Born `draft` unless `status` is supplied; the
   *  counts default to 0 in the schema. A write, so `tx` is required. */
  async create(
    data: Prisma.ImportUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<Import> {
    return tx.import.create({ data });
  },

  /** Patch an import's mutable columns in place — its `status`, the per-outcome
   *  `*Count` tallies, the confirmed `mapping`, `sourceRef`. A write, so `tx` is
   *  required. (Advancing the run's lifecycle is MOTIR-941's job; this is the
   *  single-op the engine calls.) */
  async update(
    id: string,
    data: Prisma.ImportUncheckedUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<Import> {
    return tx.import.update({ where: { id }, data });
  },

  /** One import RUN by id, or null. Optional `tx` joins a surrounding
   *  transaction (the engine re-reads the run under its own tx). */
  async findById(id: string, tx?: Prisma.TransactionClient): Promise<Import | null> {
    const client = tx ?? db;
    return client.import.findUnique({ where: { id } });
  },

  /** Find the most recent SUCCEEDED or PARTIALLY_FAILED import RUN for a
   *  project (the import step's completion exit check). Returns null when no
   *  import has completed for this project yet. */
  async findCompletedForProject(projectId: string, workspaceId: string): Promise<Import | null> {
    return db.import.findFirst({
      where: {
        projectId,
        workspaceId,
        status: { in: ['succeeded', 'partially_failed'] },
      },
      orderBy: { updatedAt: 'desc' },
    });
  },
};
