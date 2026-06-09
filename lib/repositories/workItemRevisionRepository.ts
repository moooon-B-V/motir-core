import { Prisma, type WorkItemRevision } from '@prisma/client';
import { db } from '@/lib/db';

// Work-item-revision repository — single Prisma operations on the
// `work_item_revision` table (Subtask 1.4.6). The audit-trail leaf the
// work-item write flows persist through: workItemsService records a revision
// via workItemRevisionsService.recordRevision, which calls `create` here
// inside the SAME transaction as the mutation it describes.
//
// Layer rules (CLAUDE.md): the write (`create`) REQUIRES `tx` so a revision
// can only be written inside a transaction — that's the compile-time half of
// the atomicity guarantee (a revision commits with its mutation, or not at
// all). The read (`listByWorkItem`) is a pure read path → `db` singleton.
// No business logic, no transactions, no DTO mapping here (the mapper —
// lib/mappers/workItemRevisionMappers.ts — owns the Prisma → DTO conversion).
//
// No error translation: the table has no triggers, and a cross-workspace
// write attempt is caught by the RLS policy's WITH CHECK (42501) rather than
// by anything this layer needs to interpret.

export const workItemRevisionRepository = {
  /**
   * Insert one revision row. Required `tx` — a revision MUST commit atomically
   * with the work-item mutation it describes (if the mutation rolls back, so
   * does the revision, and vice versa). Uses the unchecked create input so the
   * caller passes scalar foreign keys (`workItemId` / `changedById`) directly
   * rather than nested `connect` wrappers — the service already holds the ids.
   */
  async create(
    data: Prisma.WorkItemRevisionUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<WorkItemRevision> {
    return tx.workItemRevision.create({ data });
  },

  /**
   * The revision history of one work item, newest first (`changedAt DESC`) so
   * the activity feed renders most-recent-at-top. Read-only path → `db`
   * singleton. Cursor-paginated like workItemRepository.findByProject:
   * `cursor` is a revision id, and when present the row AT the cursor is
   * skipped (`skip: 1`) so paging doesn't repeat it. Backed by the
   * (workItemId, changedAt) index.
   */
  async listByWorkItem(
    workItemId: string,
    options: { take?: number; cursor?: string } = {},
  ): Promise<WorkItemRevision[]> {
    const { take = 50, cursor } = options;
    return db.workItemRevision.findMany({
      where: { workItemId },
      // `id` is a required secondary sort: `changedAt` alone is not a total
      // order — two revisions written in the same millisecond tie, and an
      // unbroken tie makes BOTH the rendered order AND cursor pagination
      // (cursor:{id}+skip:1) non-deterministic, so a page boundary that lands
      // mid-tie can skip or repeat a row. cuid `id`s are monotonic-ish and
      // unique, giving a stable tiebreaker (PRODECT_FINDINGS #38).
      orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  },

  /**
   * How many DISTINCT issues were associated with `sprintId` AFTER `after` — the
   * Jira "issues added during the sprint" figure the sprint report shows (Story
   * 4.4.4). An association write records a `{ sprintId: { from, to } }` diff
   * (`assignToSprint` / `setSprint`, Story 4.1.4), so an issue "added after
   * start" is one with an `updated` revision whose `diff.sprintId.to` equals this
   * sprint and whose `changedAt` is past the sprint's `startDate`. The relation
   * filter scopes to issues CURRENTLY in the sprint (non-archived) so a
   * removed-then-not-readded issue doesn't inflate the count, and `workspaceId`
   * gates the read (finding #26). `distinct` collapses an issue with several such
   * revisions to one — the result is bounded by the sprint's own additions (an
   * aggregate, not a load-all; finding #57). Read-only path → `db` singleton.
   */
  async countItemsAddedToSprintAfter(
    sprintId: string,
    workspaceId: string,
    after: Date,
  ): Promise<number> {
    const rows = await db.workItemRevision.findMany({
      where: {
        changeKind: 'updated',
        changedAt: { gt: after },
        diff: { path: ['sprintId', 'to'], equals: sprintId },
        workItem: { sprintId, workspaceId, archivedAt: null },
      },
      distinct: ['workItemId'],
      select: { workItemId: true },
    });
    return rows.length;
  },
};
