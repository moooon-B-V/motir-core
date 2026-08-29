import type { DispatchRunCard, Prisma } from '@/generated/prisma/client';

// Single Prisma operations on `dispatch_run_card` — one LEG per card a run owns
// (Story MOTIR-1789 · MOTIR-1791, ADR `docs/decisions/dispatch-run-record.md`).
//
// `tx` on every method, reads included: the table is RLS-gated on
// `app.workspace_id`, and a read outside a bound transaction returns an empty
// list rather than an error (see `dispatchRunRepository`'s header for the full
// argument).
//
// ⚠️ A LEG WHOSE `work_item_id` HAS GONE NULL IS A LEG, NOT A BROKEN ROW. The FK
// is `SET NULL` so a run's history outlives a deleted card, and `work_item_key`
// keeps the key the run actually saw. Nothing here filters those rows out, and
// nothing here throws on one — every renderer downstream has to handle the null
// arm, so the repository must not hide it by returning a shorter list than the
// run's own `position` sequence implies.

export const dispatchRunCardRepository = {
  /**
   * The run's SET, written in one op.
   *
   * `createMany` rather than N creates because the set is settled at once — a
   * scope claim returns every member in one transaction, and a batch snapshot is
   * frozen before anything is dispatched. Writing them one at a time would leave
   * a window in which a reader sees half a run's plan, which is precisely the
   * thing storing the set is for.
   */
  async createMany(
    data: Prisma.DispatchRunCardCreateManyInput[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.dispatchRunCard.createMany({ data });
    return result.count;
  },

  /**
   * ONE leg appended after the fact — `motir auto`, which holds no plan and
   * discovers its set one card per iteration.
   *
   * Its own method rather than a one-element {@link createMany} because it needs
   * the created row back: the appending caller has to know the leg's id to hang
   * the iteration's events off it.
   */
  async create(
    data: Prisma.DispatchRunCardCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRunCard> {
    return tx.dispatchRunCard.create({ data });
  },

  /** The run's legs in its own stored order. Never re-derive that order. */
  async listByRun(dispatchRunId: string, tx: Prisma.TransactionClient): Promise<DispatchRunCard[]> {
    return tx.dispatchRunCard.findMany({
      where: { dispatchRunId },
      orderBy: { position: 'asc' },
    });
  },

  /**
   * One leg, addressed the way a reporter addresses it: by the run and the card.
   *
   * ⚠️ `workItemId` IS NULLABLE AND THE UNIQUE INDEX TREATS NULLS AS DISTINCT, so
   * this lookup is only meaningful for a leg whose card still exists. A caller
   * holding a null has no leg to find and must address it by `id` instead —
   * which is why this returns `null` for a null `workItemId` rather than
   * matching an arbitrary orphan.
   */
  async findByRunAndWorkItem(
    dispatchRunId: string,
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRunCard | null> {
    return tx.dispatchRunCard.findUnique({
      where: { dispatchRunId_workItemId: { dispatchRunId, workItemId } },
    });
  },

  /** One leg by its own id — the address that keeps working after the card is gone. */
  async findById(id: string, tx: Prisma.TransactionClient): Promise<DispatchRunCard | null> {
    return tx.dispatchRunCard.findUnique({ where: { id } });
  },

  /**
   * The card's own leg history, newest first — every run that has worked it.
   *
   * Cursor-paginated for the same reason the run history is: a card worked
   * nightly accumulates one leg per night, for ever.
   */
  async listByWorkItem(
    workItemId: string,
    { take, cursor }: { take: number; cursor?: string | undefined },
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRunCard[]> {
    return tx.dispatchRunCard.findMany({
      where: { workItemId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  },

  /**
   * Advance one leg. `tx` required — a write.
   *
   * ⚠️ THE `skip_reason` CHECK CONSTRAINT IS THE ARBITER, NOT THIS METHOD. The
   * migration asserts `(disposition = 'skipped') = (skip_reason IS NOT NULL)` in
   * both directions, so an update that sets one without the other is refused by
   * the database rather than by a rule someone can forget to re-state here.
   */
  async update(
    id: string,
    data: Prisma.DispatchRunCardUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRunCard> {
    return tx.dispatchRunCard.update({ where: { id }, data });
  },
};
