import { Prisma, type Comment } from '@prisma/client';
import { db } from '@/lib/db';

// Comment repository — single Prisma operations on the `comment` table
// (Story 5.1 · Subtask 5.1.1). The persistence leaf under commentsService
// (5.1.2), which owns the transactions, the permission matrix, the
// single-level-threading validation (depth >1 rejected THERE — the schema
// only carries the self-FK), mention parsing, and DTO mapping.
//
// Layer rules (CLAUDE.md): writes REQUIRE `tx` (a comment write always rides
// a transaction — its mention rows and, on delete, the work_item_revision
// deletion record must commit atomically with it). Pure read paths use the
// `db` singleton (optional `tx` for reads inside a transaction). No business
// logic, no transactions, no DTO mapping here.
//
// No error translation: the table has no triggers; a cross-workspace write
// attempt is caught by the RLS policy's WITH CHECK (42501) for non-bypass
// roles, and the service's own view-gate is the application-layer guard.

/**
 * A root comment with its (single-level) thread riding along — the shape
 * `listThreadsByWorkItem` returns. Replies are bounded by the one-level
 * threading decision, so a thread always loads whole (Story 5.1).
 */
export type CommentWithReplies = Prisma.CommentGetPayload<{ include: { replies: true } }>;

export const commentRepository = {
  /**
   * Insert one comment. Required `tx` — the mention rows the service parses
   * out of the body persist in the SAME transaction (5.1.2). Unchecked input:
   * the service already holds the scalar FKs (workspaceId / workItemId /
   * authorId / parentCommentId).
   */
  async create(
    data: Prisma.CommentUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<Comment> {
    return tx.comment.create({ data });
  },

  /**
   * Patch one comment (the body edit — the service sets `editedAt` alongside
   * `bodyMd`, driving the "Edited" tag). Required `tx`: an edit re-parses
   * mentions and diffs their rows in the same transaction.
   */
  async update(
    id: string,
    patch: Prisma.CommentUncheckedUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<Comment> {
    return tx.comment.update({ where: { id }, data: patch });
  },

  /**
   * Re-point every comment of one work item onto another (Story 6.11 · Subtask
   * 6.11.5 — mark-duplicate / merge). The triage-merge action folds a duplicate
   * submission's whole comment thread into the canonical item by moving the
   * rows wholesale: `parentCommentId` is untouched, so a root and its replies
   * move together and the one-level thread structure is preserved (mention rows
   * ride along unchanged — they key off `commentId`, not `workItemId`).
   * Required `tx` — this commits atomically with the duplicate's cancel + the
   * `duplicates` link. Returns the number of comments moved.
   */
  async reassignWorkItem(
    fromWorkItemId: string,
    toWorkItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.comment.updateMany({
      where: { workItemId: fromWorkItemId },
      data: { workItemId: toWorkItemId },
    });
    return result.count;
  },

  /**
   * HARD-delete one comment (the Jira-faithful semantics — no tombstone).
   * The DB cascades take the replies (for a root) and every mention row with
   * it; the surviving trace is the `work_item_revision` deletion record the
   * service writes in the SAME transaction (5.1.2) — hence required `tx`.
   */
  async delete(id: string, tx: Prisma.TransactionClient): Promise<Comment> {
    return tx.comment.delete({ where: { id } });
  },

  async findById(id: string, tx?: Prisma.TransactionClient): Promise<Comment | null> {
    const client = tx ?? db;
    return client.comment.findUnique({ where: { id } });
  },

  /**
   * One PAGE of a work item's comment THREADS (Subtask 5.1.1, the read 5.1.2's
   * cursor-paged `listComments` composes): ROOT comments only
   * (`parentCommentId IS NULL`), each carrying its full single-level `replies`
   * thread (ordered oldest-first within the thread — replies always read
   * top-down; bounded by the one-level threading decision, so including them
   * is never an unbounded ride-along). NEVER a load-all (finding #57): `take`
   * caps the page, `cursor` (a root-comment id) resumes strictly after the
   * previous page's last root (`skip: 1`), and `order` flips the page walk —
   * `desc` reads newest-first (the "newest page + Show more comments (N
   * older)" shape), `asc` oldest-first (the Jira default sort).
   *
   * `id` is the required secondary sort: `createdAt` alone is not a total
   * order (same-millisecond writes tie), and an unbroken tie makes cursor
   * paging skip/repeat rows at a page boundary (PRODECT_FINDINGS #38). Backed
   * by the (work_item_id, created_at) index. Read-only path → `db` singleton.
   */
  async listThreadsByWorkItem(
    workItemId: string,
    options: { take?: number; cursor?: string; order?: 'asc' | 'desc' } = {},
    tx?: Prisma.TransactionClient,
  ): Promise<CommentWithReplies[]> {
    const client = tx ?? db;
    const { take = 20, cursor, order = 'desc' } = options;
    return client.comment.findMany({
      where: { workItemId, parentCommentId: null },
      include: { replies: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
      orderBy: [{ createdAt: order }, { id: order }],
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  },

  /**
   * How many comments a work item holds — replies INCLUDED (the Activity
   * section's header count: "N comments" counts every comment, not threads).
   * The denominator behind "Show more comments (N older)". Read-only path →
   * `db` singleton.
   */
  async countByWorkItem(workItemId: string, tx?: Prisma.TransactionClient): Promise<number> {
    const client = tx ?? db;
    return client.comment.count({ where: { workItemId } });
  },

  /**
   * How many replies a ROOT comment holds (Subtask 5.1.2) — the count the
   * delete path records in the `work_item_revision` deletion trace (and the
   * 5.1.5 confirm copy names) BEFORE the cascade takes the thread. Takes `tx`
   * when read inside the delete transaction.
   */
  async countByParent(parentCommentId: string, tx?: Prisma.TransactionClient): Promise<number> {
    const client = tx ?? db;
    return client.comment.count({ where: { parentCommentId } });
  },

  /**
   * How many ROOT comments (threads) a work item holds — the paging
   * denominator for `listThreadsByWorkItem` (pages walk roots, so "is there
   * another page" is a root count, not a total count).
   */
  async countRootsByWorkItem(workItemId: string, tx?: Prisma.TransactionClient): Promise<number> {
    const client = tx ?? db;
    return client.comment.count({ where: { workItemId, parentCommentId: null } });
  },

  /**
   * A ROOT comment's replies, oldest first (Subtask 5.2.3) — the delete path
   * reads the thread's bodies BEFORE the cascade takes them, so the
   * link-on-write sync can unlink the attachment rows those bodies
   * referenced. Bounded by the single-level-threading rule (replies of one
   * root, never a tree walk). Takes `tx` when read inside the delete
   * transaction.
   */
  async listReplies(parentCommentId: string, tx?: Prisma.TransactionClient): Promise<Comment[]> {
    const client = tx ?? db;
    return client.comment.findMany({
      where: { parentCommentId },
      orderBy: { createdAt: 'asc' },
    });
  },

  /**
   * Whether ANY comment on the work item still references `text` (Subtask
   * 5.2.3) — the still-referenced-elsewhere guard the unlink path runs per
   * de-referenced blob URL before letting a row go GC-eligible. A bounded
   * existence probe (`findFirst` on the indexed work_item_id, substring match
   * on the candidate bodies), never a table scan; runs inside the write tx so
   * it sees the body state the current write produced.
   */
  async someBodyReferences(
    workItemId: string,
    text: string,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const client = tx ?? db;
    const row = await client.comment.findFirst({
      where: { workItemId, bodyMd: { contains: text } },
      select: { id: true },
    });
    return row !== null;
  },
};
