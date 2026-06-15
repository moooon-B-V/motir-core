import { Prisma, type PublicRequestVote } from '@prisma/client';

// publicRequestVoteRepository (Story 6.12 · Subtask 6.12.6) — single-op access
// to the `public_request_vote` join. One vote per (request, account) is the
// server-enforced rule (the schema `@@unique([workItemId, userId])` from
// 6.12.3); the SERVICE owns the toggle transaction + the work_item row lock.
//
// RLS (6.12.3): `public_request_vote` is FORCE-RLS, keyed on the `app.user_id`
// GUC for the owner's own rows and `app.system_admin` for the cross-account
// COUNT. So the write methods run inside a `withUserContext` tx (the voter casts
// only their OWN vote) and the aggregate `countByWorkItem` runs inside a
// `withSystemContext` tx (it spans every voter) — the service binds the right
// context and threads its `tx` here.

export const publicRequestVoteRepository = {
  /**
   * The caller's vote on one request, or null. Used inside the toggle tx to
   * decide insert-vs-delete, so it takes the tx (the read guards the write).
   */
  async findByWorkItemAndUser(
    workItemId: string,
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PublicRequestVote | null> {
    return tx.publicRequestVote.findUnique({
      where: { workItemId_userId: { workItemId, userId } },
    });
  },

  /** Record one upvote. Required `tx` — runs in the toggle transaction. */
  async create(
    data: { workItemId: string; userId: string },
    tx: Prisma.TransactionClient,
  ): Promise<PublicRequestVote> {
    return tx.publicRequestVote.create({ data });
  },

  /**
   * Remove the caller's upvote (the toggle-off path). Required `tx`. Returns the
   * number of rows deleted (0 when nothing was there — idempotent).
   */
  async deleteByWorkItemAndUser(
    workItemId: string,
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const r = await tx.publicRequestVote.deleteMany({ where: { workItemId, userId } });
    return r.count;
  },

  /**
   * How many accounts have upvoted one request — the demand signal. Spans every
   * voter, so the service runs this under `withSystemContext` (the
   * cross-account COUNT the RLS `system_admin` branch admits); it takes the tx.
   */
  async countByWorkItem(workItemId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.publicRequestVote.count({ where: { workItemId } });
  },
};
