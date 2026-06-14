import { Prisma, type WorkItemRevision } from '@prisma/client';
import { db } from '@/lib/db';
import type { FilterAst } from '@/lib/filters/ast';
import type { ProjectFilterReferents } from '@/lib/filters/registry';
import { compileFilterConditionsSql } from '@/lib/repositories/workItemRepository';

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
   * The revision history of one work item, newest first (`changedAt DESC`) by
   * default so the activity feed renders most-recent-at-top; `order: 'asc'`
   * (Subtask 5.5.1 — the Activity section's oldest-first toggle) walks the
   * SAME (workItemId, changedAt) index in the other direction. Read-only path
   * → `db` singleton. Cursor-paginated like workItemRepository.findByProject:
   * `cursor` is a revision id, and when present the row AT the cursor is
   * skipped (`skip: 1`) so paging doesn't repeat it.
   */
  async listByWorkItem(
    workItemId: string,
    options: { take?: number; cursor?: string; order?: 'asc' | 'desc' } = {},
  ): Promise<WorkItemRevision[]> {
    const { take = 50, cursor, order = 'desc' } = options;
    return db.workItemRevision.findMany({
      where: { workItemId },
      // `id` is a required secondary sort: `changedAt` alone is not a total
      // order — two revisions written in the same millisecond tie, and an
      // unbroken tie makes BOTH the rendered order AND cursor pagination
      // (cursor:{id}+skip:1) non-deterministic, so a page boundary that lands
      // mid-tie can skip or repeat a row. cuid `id`s are monotonic-ish and
      // unique, giving a stable tiebreaker (PRODECT_FINDINGS #38).
      orderBy: [{ changedAt: order }, { id: order }],
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  },

  /**
   * How many of a work item's revisions are DISPLAYABLE in the History feed
   * (Subtask 5.5.1) — the `totalCount` behind the tab badge / "Show more"
   * copy. A revision displays unless it is an `updated`-family row whose
   * EVERY diff key is in `suppressedKeys` (the registry's explicit noise
   * policy — pure board-reorder writes); `created` / `archived` anchors always
   * display. One grouped count, never a load-all (finding #57). The predicate
   * mirrors `isDisplayableRevision` in lib/activity/renderers.ts — both read
   * the same suppression list, so the count and the page filter can't drift.
   * `jsonb_typeof` guards the (never-written, but JSON-typed) non-object diff.
   * Read-only path → `db` singleton.
   */
  async countDisplayableByWorkItem(workItemId: string, suppressedKeys: string[]): Promise<number> {
    const rows = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count
      FROM "work_item_revision" r
      WHERE r."workItemId" = ${workItemId}
        AND (
          r."changeKind" IN ('created', 'archived')
          OR (
            jsonb_typeof(r."diff") = 'object'
            AND EXISTS (
              SELECT 1 FROM jsonb_object_keys(r."diff") AS k(key)
              WHERE NOT (k.key = ANY(${suppressedKeys}))
            )
          )
        )
    `;
    // count(*) always yields exactly one row.
    return Number((rows[0] as { count: bigint }).count);
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
   * The IDS of the issues currently in `sprintId` that were associated with it
   * AFTER `after` — the same "added during sprint" set
   * `countItemsAddedToSprintAfter` counts, returned as ids so
   * `sprintsService.completeSprint` can FREEZE the flag per issue into the
   * sprint-report snapshot (bug-sprint-report-incomplete-list-zero-after-carry-
   * over). Called inside the completion transaction BEFORE the carry-over moves
   * anything, so the `workItem: { sprintId }` relation filter still matches the
   * about-to-be-carried issues; takes an optional `tx` so the read shares that
   * transaction. `distinct` collapses an issue with several such revisions to
   * one; `workspaceId` gates the read (finding #26). Bounded by the sprint's own
   * additions (finding #57).
   */
  async findItemIdsAddedToSprintAfter(
    sprintId: string,
    workspaceId: string,
    after: Date,
    tx?: Prisma.TransactionClient,
  ): Promise<string[]> {
    const client = tx ?? db;
    const rows = await client.workItemRevision.findMany({
      where: {
        changeKind: 'updated',
        changedAt: { gt: after },
        diff: { path: ['sprintId', 'to'], equals: sprintId },
        workItem: { sprintId, workspaceId, archivedAt: null },
      },
      distinct: ['workItemId'],
      select: { workItemId: true },
    });
    return rows.map((r) => r.workItemId);
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

  /**
   * The RESOLVED series of the created-vs-resolved report (Story 6.3 ·
   * Subtask 6.3.2): per `date_trunc(period, changedAt)` bucket, the NET
   * count of status transitions into a `done`-CATEGORY status — `+1` for a
   * transition INTO done (from a non-done status), `-1` for a transition OUT
   * of done (a reopen inside the window subtracts, the card's net rule) — in
   * ONE bounded grouped `$queryRaw` over the 1.4.6 trail (the 4.6.3 pattern;
   * finding #57 — never an all-revisions load + JS reduce; the result is
   * bounded by the bucket cap the service validates).
   *
   * "Done" resolves exactly like `aggregateSprintBurndownByDay`: join
   * `workflow_status` on the diff's from/to status KEYS and read
   * `category = 'done'` — the SAME predicate `getTerminalStatusKeys` / the
   * burndown / velocity / rollups resolve (the recorded deviation: our
   * "resolution" IS the done category), so every report agrees on "done".
   * `period` is a closed `day|week|month` union bound as a parameter. The
   * optional compiled FilterAST (the 6.1.1 compiler over the joined
   * `work_item` alias `w`; stale referents → match-nothing per 6.1.2)
   * narrows to the saved-filter scope; archived items are excluded (matching
   * the created series + the /issues parity basis). `workspaceId` gates the
   * read (finding #26). Buckets with no events return no row (the service
   * fills the axis). Read-only path → `db` singleton.
   */
  async aggregateNetResolvedByBucket(
    projectId: string,
    workspaceId: string,
    period: 'day' | 'week' | 'month',
    window: { start: Date; end: Date },
    filter?: { ast?: FilterAst; referents?: ProjectFilterReferents },
  ): Promise<Array<{ bucket: string; resolved: number }>> {
    const astSql = filter?.ast
      ? compileFilterConditionsSql(filter.ast, filter.referents)
      : Prisma.sql`TRUE`;
    return db.$queryRaw<Array<{ bucket: string; resolved: number }>>`
      SELECT
        to_char(date_trunc(${period}, r."changedAt"), 'YYYY-MM-DD') AS "bucket",
        COALESCE(SUM(
          CASE
            WHEN ts."category" = 'done' AND (fs."category" IS NULL OR fs."category" <> 'done') THEN 1
            WHEN (ts."category" IS NULL OR ts."category" <> 'done') AND fs."category" = 'done' THEN -1
            ELSE 0
          END
        ), 0)::int AS "resolved"
      FROM "work_item_revision" r
      JOIN "work_item" w
        ON w."id" = r."workItemId"
       AND w."projectId" = ${projectId}
       AND w."workspaceId" = ${workspaceId}
       AND w."archivedAt" IS NULL
       AND (${astSql})
      LEFT JOIN "workflow_status" fs
        ON fs."project_id" = w."projectId"
       AND fs."key" = (r."diff" -> 'status' ->> 'from')
      LEFT JOIN "workflow_status" ts
        ON ts."project_id" = w."projectId"
       AND ts."key" = (r."diff" -> 'status' ->> 'to')
      WHERE r."changeKind" = 'updated'
        AND r."diff" -> 'status' IS NOT NULL
        AND r."changedAt" >= ${window.start}
        AND r."changedAt" <= ${window.end}
      GROUP BY 1
      ORDER BY 1
    `;
  },
};
