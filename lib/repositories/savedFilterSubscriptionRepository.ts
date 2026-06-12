import { Prisma, type SavedFilterSubscription } from '@prisma/client';
import { db } from '@/lib/db';

// Saved-filter subscription data access (Story 6.2 · Subtask 6.2.5). Single
// Prisma ops; writes require `tx` (CLAUDE.md). The cron's due scan is bounded +
// cursor-paged (finding #57 — a deployment with thousands of subscriptions
// never builds one unbounded in-memory batch); it narrows on the indexed
// `hour` column and the SERVICE applies the schedule/weekday predicate in
// memory (a cheap per-row check the index can't express).

/** One page of due-candidate subscriptions for the cron tick — read under
 * withSystemContext (cross-workspace; the system-admin RLS branch). */
export interface DueSubscriptionsPageArgs {
  /** The current UTC hour (0–23) — only rows configured for this hour. */
  hour: number;
  take: number;
  cursor?: string;
}

export const savedFilterSubscriptionRepository = {
  /** The (filter, user) subscription, if any — the subscribed-state read and
   * the upsert pre-check. */
  async findByFilterAndUser(
    savedFilterId: string,
    userId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<SavedFilterSubscription | null> {
    const client = tx ?? db;
    return client.savedFilterSubscription.findUnique({
      where: { savedFilterId_userId: { savedFilterId, userId } },
    });
  },

  /** One subscription by id — the delivery read (the cron resolves the row
   * before sending) and the token-unsubscribe read. */
  async findById(
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<SavedFilterSubscription | null> {
    const client = tx ?? db;
    return client.savedFilterSubscription.findUnique({ where: { id } });
  },

  /** Count a filter's subscriptions — the 6.2.1 dependents warning. */
  async countByFilter(savedFilterId: string): Promise<number> {
    return db.savedFilterSubscription.count({ where: { savedFilterId } });
  },

  /**
   * One page of subscriptions configured for `hour`, id-ordered with a
   * `take + 1` peek for the cursor. The schedule/weekday gate is applied by
   * the service over these rows (the hourly index pre-narrows the scan).
   */
  async listDueByHour(
    args: DueSubscriptionsPageArgs,
    tx?: Prisma.TransactionClient,
  ): Promise<SavedFilterSubscription[]> {
    const client = tx ?? db;
    return client.savedFilterSubscription.findMany({
      where: { hour: args.hour },
      orderBy: { id: 'asc' },
      take: args.take,
      ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
    });
  },

  async create(
    data: Prisma.SavedFilterSubscriptionUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<SavedFilterSubscription> {
    return tx.savedFilterSubscription.create({ data });
  },

  async update(
    id: string,
    data: Pick<Prisma.SavedFilterSubscriptionUncheckedUpdateInput, 'schedule' | 'weekday' | 'hour'>,
    tx: Prisma.TransactionClient,
  ): Promise<SavedFilterSubscription> {
    return tx.savedFilterSubscription.update({ where: { id }, data });
  },

  /** Delete the (filter, user) subscription — the in-app unsubscribe.
   * Idempotent: returns the deleted count (0 when there was none). */
  async deleteByFilterAndUser(
    savedFilterId: string,
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const r = await tx.savedFilterSubscription.deleteMany({ where: { savedFilterId, userId } });
    return r.count;
  },

  /** Delete one subscription by id — the token (email) unsubscribe.
   * Idempotent (0 when already gone). */
  async deleteById(id: string, tx: Prisma.TransactionClient): Promise<number> {
    const r = await tx.savedFilterSubscription.deleteMany({ where: { id } });
    return r.count;
  },
};
