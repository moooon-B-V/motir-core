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

  /**
   * The BOUNDED per-day event aggregate that drives the in-sprint BURNDOWN
   * actual line (Story 4.6.3). In ONE grouped `$queryRaw` — never a load-all of
   * the revision rows + a client reduce (finding #57) — it walks the
   * `work_item_revision` trail scoped to (the sprint window) ∧ (this sprint's
   * issues OR a sprint-association change touching this sprint), and emits, per
   * UTC calendar day, the signed change to "remaining work":
   *   • a status transition INTO a `done`-category status (and out of a non-done
   *     one) BURNS down  → `-stat`
   *   • a transition OUT of done (reopened)                    → `+stat`
   *   • an issue ADDED to this sprint after start (scope up)   → `+stat`
   *   • an issue REMOVED from this sprint (scope down)         → `-stat`
   * `stat` is the per-issue statistic: `COALESCE(storyPoints, 0)` for the points
   * series, or `1` for the issue-count series (`useCount`). An issue unestimated
   * at read time contributes 0 to the points series (its `storyPoints` is NULL),
   * never `NaN`.
   *
   * "Done" is resolved by joining `workflow_status` on the diff's `from`/`to`
   * status KEYS (the diff stores keys — `workItemsService.moveStatus`, 1.4.6 /
   * 2.2) and reading `category = 'done'` — the SAME predicate
   * `workItemRepository.sumPointsForSprint` (4.3.3) uses inline, so the
   * burndown's end-of-series remaining reconciles with `rollupForSprint`.
   * Status events are scoped to issues CURRENTLY in the sprint (`w."sprintId" =`
   * the sprint, non-archived) — matching the roll-up's current-members basis —
   * while association events are matched on the diff regardless of current
   * membership. `workspaceId` gates the read (finding #26). The result is
   * bounded by the sprint length (one row per day with events, ≤ ~14), GROUPed
   * server-side. Read-only path → `db` singleton.
   *
   * `remainingDelta` is the net change to remaining (all four event kinds);
   * `scopeDelta` is the subset from association changes only (the chart's
   * scope-change markers). A sprint with no qualifying revisions returns no rows
   * (the caller derives a flat-at-committed line).
   */
  async aggregateSprintBurndownByDay(
    sprintId: string,
    workspaceId: string,
    window: { start: Date; end: Date },
    useCount: boolean,
  ): Promise<Array<{ day: string; remainingDelta: number; scopeDelta: number }>> {
    // The per-issue statistic value — an internal literal expression, never user
    // input (mirrors `pointsAggExpr` in workItemRepository).
    const stat = useCount ? Prisma.sql`1` : Prisma.sql`COALESCE(w."storyPoints", 0)`;
    // Reused predicates for the four event kinds.
    const isStatusEvent = Prisma.sql`r."diff" -> 'status' IS NOT NULL AND w."sprintId" = ${sprintId}`;
    const burnedDown = Prisma.sql`${isStatusEvent} AND ts."category" = 'done' AND (fs."category" IS NULL OR fs."category" <> 'done')`;
    const reopened = Prisma.sql`${isStatusEvent} AND (ts."category" IS NULL OR ts."category" <> 'done') AND fs."category" = 'done'`;
    const scopeUp = Prisma.sql`(r."diff" -> 'sprintId' ->> 'to') = ${sprintId} AND COALESCE(r."diff" -> 'sprintId' ->> 'from', '') <> ${sprintId}`;
    const scopeDown = Prisma.sql`(r."diff" -> 'sprintId' ->> 'from') = ${sprintId} AND COALESCE(r."diff" -> 'sprintId' ->> 'to', '') <> ${sprintId}`;

    return db.$queryRaw<Array<{ day: string; remainingDelta: number; scopeDelta: number }>>`
      SELECT
        to_char(date_trunc('day', r."changedAt"), 'YYYY-MM-DD') AS "day",
        COALESCE(SUM(
          CASE
            WHEN ${burnedDown} THEN -1 * (${stat})
            WHEN ${reopened} THEN (${stat})
            WHEN ${scopeUp} THEN (${stat})
            WHEN ${scopeDown} THEN -1 * (${stat})
            ELSE 0
          END
        ), 0)::float8 AS "remainingDelta",
        COALESCE(SUM(
          CASE
            WHEN ${scopeUp} THEN (${stat})
            WHEN ${scopeDown} THEN -1 * (${stat})
            ELSE 0
          END
        ), 0)::float8 AS "scopeDelta"
      FROM "work_item_revision" r
      JOIN "work_item" w
        ON w."id" = r."workItemId"
       AND w."workspaceId" = ${workspaceId}
       AND w."archivedAt" IS NULL
      LEFT JOIN "workflow_status" fs
        ON fs."project_id" = w."projectId"
       AND fs."key" = (r."diff" -> 'status' ->> 'from')
      LEFT JOIN "workflow_status" ts
        ON ts."project_id" = w."projectId"
       AND ts."key" = (r."diff" -> 'status' ->> 'to')
      WHERE r."changeKind" = 'updated'
        AND r."changedAt" >= ${window.start}
        AND r."changedAt" <= ${window.end}
        AND (
              ${isStatusEvent}
              OR (r."diff" -> 'sprintId' ->> 'to') = ${sprintId}
              OR (r."diff" -> 'sprintId' ->> 'from') = ${sprintId}
            )
      GROUP BY 1
      ORDER BY 1
    `;
  },
};
