import type { Prisma } from '@/generated/prisma/client';

/**
 * The platform RUN-MODEL LIST (Story MOTIR-7521 · MOTIR-7525) — which models a
 * hosted run may use, and the marker that says the list was initialised.
 *
 * Every method takes `tx`: the WRITES run inside `withPlatformRead` (the
 * `app.platform_staff` arm the tables' write policies read), and the reads run
 * in the transaction whose write they guard or whose page they draw. The
 * tables' SELECT policy is unconditional (the list is platform reference data
 * every tenant's offer is narrowed by).
 */

/** The marker's one id — the list is platform-wide, so there is exactly one. */
export const PLATFORM_RUN_MODEL_LIST_ID = 'platform';

/** One listed model, as stored. */
export interface PlatformRunModelRow {
  model: string;
  addedById: string | null;
  createdAt: Date;
}

const ROW = { model: true, addedById: true, createdAt: true } as const;

export const platformRunModelRepository = {
  /** Whether the list was ever initialised — the marker row exists. */
  async isInitialized(tx: Prisma.TransactionClient): Promise<boolean> {
    const marker = await tx.platformRunModelList.findUnique({
      where: { id: PLATFORM_RUN_MODEL_LIST_ID },
      select: { id: true },
    });
    return marker !== null;
  },

  /**
   * Write the marker unless it exists, and say whether THIS call wrote it. A
   * concurrent first read blocks on the primary key until the first commits,
   * then inserts nothing — which is what makes the seed run exactly once.
   */
  async insertMarkerIfAbsent(tx: Prisma.TransactionClient): Promise<boolean> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "platform_run_model_list" ("id")
      VALUES (${PLATFORM_RUN_MODEL_LIST_ID})
      ON CONFLICT ("id") DO NOTHING
      RETURNING "id"`;
    return rows.length === 1;
  },

  /** Every listed model, oldest first. */
  async list(tx: Prisma.TransactionClient): Promise<PlatformRunModelRow[]> {
    return tx.platformRunModel.findMany({
      select: ROW,
      orderBy: [{ createdAt: 'asc' }, { model: 'asc' }],
    });
  },

  /** One listed model, or null. */
  async findByModel(
    model: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlatformRunModelRow | null> {
    return tx.platformRunModel.findUnique({ where: { model }, select: ROW });
  },

  /** The seed: every model at once, unattributed. Skips a model already listed. */
  async createSeeded(models: string[], tx: Prisma.TransactionClient): Promise<number> {
    const r = await tx.platformRunModel.createMany({
      data: models.map((model) => ({ model })),
      skipDuplicates: true,
    });
    return r.count;
  },

  /** One operator add. */
  async create(
    model: string,
    addedById: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlatformRunModelRow> {
    return tx.platformRunModel.create({ data: { model, addedById }, select: ROW });
  },

  /** One operator remove; the count is 0 when the model was not listed. */
  async deleteByModel(model: string, tx: Prisma.TransactionClient): Promise<number> {
    const r = await tx.platformRunModel.deleteMany({ where: { model } });
    return r.count;
  },
};
