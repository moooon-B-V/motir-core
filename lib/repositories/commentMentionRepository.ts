import { Prisma, type CommentMention } from '@prisma/client';
import { db } from '@/lib/db';

// Comment-mention repository — single Prisma operations on the
// `comment_mention` table (Story 5.1 · Subtask 5.1.1): the queryable
// "comments mentioning me" substrate. The SERVICE (5.1.2) is the authority
// on what lands here — it parses the `[@Name](mention:<userId>)` tokens,
// validates each mentioned user can VIEW the issue (silently dropping the
// rest — the Jira rule), dedups, and persists rows in the SAME transaction
// as the comment write. This layer is the bare row access.
//
// Layer rules (CLAUDE.md): writes REQUIRE `tx`; reads use the `db` singleton.
// Deleting a comment cascades its mention rows at the DB layer, so
// `deleteByCommentId` exists for the EDIT re-parse path (diffing a body's
// mention set), not for comment deletion.

export const commentMentionRepository = {
  /**
   * Insert the validated mention rows of one comment in a single round-trip.
   * Required `tx` — mentions commit atomically with the comment write they
   * describe. The service dedups before calling (the
   * `@@unique([commentId, mentionedUserId])` constraint is the DB backstop —
   * a duplicate surfaces as P2002, a service bug, never silently absorbed).
   * Empty input short-circuits to 0 so no degenerate INSERT is issued.
   */
  async createMany(
    data: Prisma.CommentMentionCreateManyInput[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (data.length === 0) return 0;
    const r = await tx.commentMention.createMany({ data });
    return r.count;
  },

  /**
   * Remove every mention row of one comment (the edit re-parse path: the
   * service diffs old vs new mention sets; a full clear-and-rewrite also
   * composes from this). Required `tx`. Returns the removed-row count.
   */
  async deleteByCommentId(commentId: string, tx: Prisma.TransactionClient): Promise<number> {
    const r = await tx.commentMention.deleteMany({ where: { commentId } });
    return r.count;
  },

  /**
   * The mention rows of a bounded comment set in ONE `IN (...)` round-trip —
   * the N+1-avoidance read behind 5.1.2's list DTOs (one page of threads →
   * one mention query). Rows come back in arbitrary order; callers bucket by
   * `commentId`. Empty input short-circuits to [] so we never issue a
   * degenerate `IN ()` (mirrors workItemRepository.findByIds). Read-only
   * path → `db` singleton.
   */
  async findByCommentIds(
    commentIds: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<CommentMention[]> {
    if (commentIds.length === 0) return [];
    const client = tx ?? db;
    return client.commentMention.findMany({ where: { commentId: { in: commentIds } } });
  },
};
