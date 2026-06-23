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
   * The ACTOR of the latest `'archived'` revision of one work item (Story 2.9 ·
   * Subtask 2.9.6) — the detail page's archived banner reads WHO archived it
   * from here (the WHEN comes from `work_item.archivedAt`). A re-archived item
   * has several `'archived'` revisions, so we take the most recent
   * (`changedAt DESC`, `id DESC` as the deterministic tiebreaker — the same
   * total order {@link listByWorkItem} uses). The author join resolves the
   * display name + avatar in the SAME read. Returns `null` when the item has no
   * `'archived'` revision (an item archived by a path that recorded none —
   * defensive; in practice `archiveWorkItem` always records one). Read-only
   * path → `db` singleton. Scopes the LATERAL pick the 2.9.3 list read does in
   * `workItemRepository.findArchivedByProject` down to one item.
   */
  async findLatestArchivedActor(
    workItemId: string,
  ): Promise<{ id: string; name: string | null; image: string | null } | null> {
    const revision = await db.workItemRevision.findFirst({
      where: { workItemId, changeKind: 'archived' },
      orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
      select: { changedBy: { select: { id: true, name: true, image: true } } },
    });
    return revision?.changedBy ?? null;
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
          r."changeKind" IN ('created', 'archived', 'unarchived')
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
   * The BOUNDED per-day event aggregate that drives the Linear-style CYCLE
   * GRAPH (Story 8.14.3) — the burn-UP of LIVE scope vs completed. In ONE
   * grouped `$queryRaw` (finding #57 — never a load-all + JS reduce) over the
   * `work_item_revision` trail scoped to (the sprint window) ∧ (this sprint's
   * issues OR a sprint-association change touching this sprint), it emits, per
   * UTC calendar day, three signed deltas the assembler cumulates into the three
   * actual series:
   *   • `scopeDelta` — the change to the LIVE total estimate in the sprint:
   *       a NOT-current-membership sprint ADD (`+stat`) / REMOVE (`−stat`), AND
   *       a `storyPoints` EDIT of a CURRENT sprint member (`to − from`). Scope is
   *       the total estimate REGARDLESS of status (a done item still counts), so
   *       — unlike the burndown — there is NO done-gate here. This live derivation
   *       is exactly what frees the chart from the immutable `committedPoints`
   *       snapshot (the MOTIR-1288 root cause). In count mode a re-estimate is a
   *       no-op (`0`); an add/remove is `±1`.
   *   • `completedDelta` — `+stat` on a transition INTO a `done`-category status
   *       (from a non-done one), `−stat` on a transition OUT of done (a reopen).
   *       Cumulates to `rollupForSprint().completed` (the SAME category predicate),
   *       so the chart reconciles with the scrum header.
   *   • `startedDelta` — `+stat` when an item LEAVES the `todo` category (into
   *       in-progress OR done — i.e. it has "started"), `−stat` when it returns to
   *       `todo`. The cumulative `started` line is therefore always ≥ `completed`
   *       and ≤ `scope` (the amber band between completed and started is the
   *       in-progress work). The default workflow has no todo→done edge, so every
   *       completion is first a start; the boundary rule generalises that safely.
   *
   * `stat` is the per-issue statistic: `COALESCE(storyPoints, 0)` for points, or
   * `1` for the issue-count series (`useCount`). Status is resolved by joining
   * `workflow_status` on the diff's `from`/`to` KEYS (the 1.4.6 trail stores keys)
   * and reading `category` — the SAME predicate `aggregateSprintCycleByDay` /
   * `sumPointsForSprint` use. Status/`storyPoints` events are scoped to issues
   * CURRENTLY in the sprint (matching the roll-up's current-members basis); add/
   * remove events match on the diff regardless of current membership.
   * `workspaceId` gates the read (finding #26); the result is bounded by the
   * sprint length (one row per day with events). Read-only path → `db` singleton.
   *
   * A sprint with no qualifying revisions returns no rows (the assembler derives
   * a flat-at-baseline series).
   */
  async aggregateSprintCycleByDay(
    sprintId: string,
    workspaceId: string,
    window: { start: Date; end: Date },
    useCount: boolean,
  ): Promise<
    Array<{ day: string; scopeDelta: number; completedDelta: number; startedDelta: number }>
  > {
    // The per-issue statistic value — an internal literal expression, never user
    // input (the same `pointsAggExpr` pattern the sprint rollups use).
    const stat = useCount ? Prisma.sql`1` : Prisma.sql`COALESCE(w."storyPoints", 0)`;
    // Status events (completed / started) are scoped to CURRENT sprint members.
    const isStatusEvent = Prisma.sql`r."diff" -> 'status' IS NOT NULL AND w."sprintId" = ${sprintId}`;
    // Completed: into a done-category status (+) / out of done on a reopen (−).
    const intoDone = Prisma.sql`${isStatusEvent} AND ts."category" = 'done' AND (fs."category" IS NULL OR fs."category" <> 'done')`;
    const outOfDone = Prisma.sql`${isStatusEvent} AND (ts."category" IS NULL OR ts."category" <> 'done') AND fs."category" = 'done'`;
    // Started: crossing the `todo` boundary. Entering = from todo/initial to a
    // non-todo category (+); leaving = from a non-todo category back to todo (−).
    // A NULL `from` category is the initial (todo) status.
    const startedEnter = Prisma.sql`${isStatusEvent} AND (fs."category" IS NULL OR fs."category" = 'todo') AND ts."category" IS NOT NULL AND ts."category" <> 'todo'`;
    const startedLeave = Prisma.sql`${isStatusEvent} AND fs."category" IS NOT NULL AND fs."category" <> 'todo' AND ts."category" = 'todo'`;
    // Scope: sprint association add/remove (matched on the diff, any membership),
    // counting ALL points (no done-gate — scope is the total live estimate).
    const scopeUp = Prisma.sql`(r."diff" -> 'sprintId' ->> 'to') = ${sprintId} AND COALESCE(r."diff" -> 'sprintId' ->> 'from', '') <> ${sprintId}`;
    const scopeDown = Prisma.sql`(r."diff" -> 'sprintId' ->> 'from') = ${sprintId} AND COALESCE(r."diff" -> 'sprintId' ->> 'to', '') <> ${sprintId}`;
    // Scope: a `storyPoints` re-estimate of a CURRENT sprint member moves live
    // scope by `to − from` (each NULL = 0). In count mode a re-estimate is a no-op.
    const isPointsEdit = Prisma.sql`r."diff" -> 'storyPoints' IS NOT NULL AND w."sprintId" = ${sprintId}`;
    const pointsEditDelta = useCount
      ? Prisma.sql`0`
      : Prisma.sql`(COALESCE((r."diff" -> 'storyPoints' ->> 'to')::numeric, 0) - COALESCE((r."diff" -> 'storyPoints' ->> 'from')::numeric, 0))`;

    return db.$queryRaw<
      Array<{ day: string; scopeDelta: number; completedDelta: number; startedDelta: number }>
    >`
      SELECT
        to_char(date_trunc('day', r."changedAt"), 'YYYY-MM-DD') AS "day",
        COALESCE(SUM(
          CASE
            WHEN ${scopeUp} THEN (${stat})
            WHEN ${scopeDown} THEN -1 * (${stat})
            WHEN ${isPointsEdit} THEN (${pointsEditDelta})
            ELSE 0
          END
        ), 0)::float8 AS "scopeDelta",
        COALESCE(SUM(
          CASE
            WHEN ${intoDone} THEN (${stat})
            WHEN ${outOfDone} THEN -1 * (${stat})
            ELSE 0
          END
        ), 0)::float8 AS "completedDelta",
        COALESCE(SUM(
          CASE
            WHEN ${startedEnter} THEN (${stat})
            WHEN ${startedLeave} THEN -1 * (${stat})
            ELSE 0
          END
        ), 0)::float8 AS "startedDelta"
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
              OR ${isPointsEdit}
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
   * "Done" resolves exactly like `aggregateSprintCycleByDay`: join
   * `workflow_status` on the diff's from/to status KEYS and read
   * `category = 'done'` — the SAME predicate `getTerminalStatusKeys` / the
   * burndown / velocity / rollups resolve (the recorded deviation: our
   * "resolution" IS the done category), so every report agrees on "done".
   * `period` is a closed `day|week|month` union bound as a parameter. The
   * optional compiled FilterAST (the 6.1.1 compiler over the joined
   * `work_item` alias `w`; stale referents → match-nothing per 6.1.2)
   * narrows to the saved-filter scope; archived items are excluded (matching
   * the created series + the /items parity basis). `workspaceId` gates the
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

  /**
   * The RESOLUTION-TIME aggregate (Story 8.8 · Subtask 8.8.13): per
   * `date_trunc(period, changedAt)` bucket keyed by the RESOLUTION date, the
   * AVERAGE of `(changedAt − createdAt)` in DAYS over every status transition
   * INTO a `done`-category status (from a non-done one) inside the window — one
   * bounded grouped `$queryRaw` over the 1.4.6 trail (the
   * `aggregateNetResolvedByBucket` pattern; finding #57). An item resolved,
   * reopened, then resolved again contributes once PER resolution event ("issues
   * that entered a done-category status in that period"). "Done" resolves like
   * every report (join `workflow_status` on the diff's from/to keys, read
   * `category = 'done'`), so the reports agree on "done". `avgDays` is `float8`
   * (a fractional day average); `resolvedCount` is the population per bucket (the
   * data-table column). Archived / triage items are excluded (the created-series
   * parity basis); `workspaceId` gates the read (finding #26). Event-less buckets
   * return no row (the service fills the axis with `avgDays: null`). Read-only →
   * `db` singleton.
   */
  async aggregateResolutionTimeByBucket(
    projectId: string,
    workspaceId: string,
    period: 'day' | 'week' | 'month',
    window: { start: Date; end: Date },
    filter?: { ast?: FilterAst; referents?: ProjectFilterReferents },
  ): Promise<Array<{ bucket: string; avgDays: number; resolvedCount: number }>> {
    const astSql = filter?.ast
      ? compileFilterConditionsSql(filter.ast, filter.referents)
      : Prisma.sql`TRUE`;
    return db.$queryRaw<Array<{ bucket: string; avgDays: number; resolvedCount: number }>>`
      SELECT
        to_char(date_trunc(${period}, r."changedAt"), 'YYYY-MM-DD') AS "bucket",
        AVG(EXTRACT(EPOCH FROM (r."changedAt" - w."createdAt")) / 86400.0)::float8 AS "avgDays",
        COUNT(*)::int AS "resolvedCount"
      FROM "work_item_revision" r
      JOIN "work_item" w
        ON w."id" = r."workItemId"
       AND w."projectId" = ${projectId}
       AND w."workspaceId" = ${workspaceId}
       AND w."archivedAt" IS NULL
       AND w."triagedAt" IS NULL
       AND (${astSql})
      LEFT JOIN "workflow_status" fs
        ON fs."project_id" = w."projectId"
       AND fs."key" = (r."diff" -> 'status' ->> 'from')
      JOIN "workflow_status" ts
        ON ts."project_id" = w."projectId"
       AND ts."key" = (r."diff" -> 'status' ->> 'to')
      WHERE r."changeKind" = 'updated'
        AND r."diff" -> 'status' IS NOT NULL
        AND ts."category" = 'done'
        AND (fs."category" IS NULL OR fs."category" <> 'done')
        AND r."changedAt" >= ${window.start}
        AND r."changedAt" <= ${window.end}
      GROUP BY 1
      ORDER BY 1
    `;
  },

  /**
   * The AVERAGE-AGE aggregate (Story 8.8 · Subtask 8.8.13): for each bucket's
   * period-END instant (passed in by the service via `lib/reports/buckets`
   * `bucketEnds` — the exclusive upper edge, capped at "now" for the current
   * bucket), the AVERAGE of `(periodEnd − createdAt)` in DAYS over issues created
   * by then and NOT yet resolved at that instant. An item's resolution point is
   * its FIRST transition INTO a `done`-category status (the `resolved` CTE — the
   * SAME done predicate every report uses); an item with no such transition (or
   * one whose first resolution is AFTER `periodEnd`) is still open. One bounded
   * grouped `$queryRaw`: the bucket (key, periodEnd) pairs are UNNESTed and
   * CROSS-joined to the scoped items, so it is a single point-in-time pass, never
   * a per-bucket round-trip (finding #57; bounded by items × ≤120 buckets).
   * Archived / triage items excluded; `workspaceId` gates the read (finding #26).
   * A bucket with no open items returns no row (the service fills `avgDays:
   * null`). Read-only → `db` singleton.
   */
  async aggregateAverageAgeByBucket(
    projectId: string,
    workspaceId: string,
    buckets: Array<{ key: string; end: Date }>,
    filter?: { ast?: FilterAst; referents?: ProjectFilterReferents },
  ): Promise<Array<{ bucket: string; avgDays: number; openCount: number }>> {
    if (buckets.length === 0) return [];
    const astSql = filter?.ast
      ? compileFilterConditionsSql(filter.ast, filter.referents)
      : Prisma.sql`TRUE`;
    const keys = buckets.map((b) => b.key);
    const ends = buckets.map((b) => b.end);
    return db.$queryRaw<Array<{ bucket: string; avgDays: number; openCount: number }>>`
      WITH be AS (
        SELECT * FROM unnest(${keys}::text[], ${ends}::timestamptz[]) AS t("key", "periodEnd")
      ),
      resolved AS (
        SELECT r."workItemId" AS "itemId", MIN(r."changedAt") AS "firstDoneAt"
        FROM "work_item_revision" r
        JOIN "work_item" w2
          ON w2."id" = r."workItemId"
         AND w2."projectId" = ${projectId}
         AND w2."workspaceId" = ${workspaceId}
        LEFT JOIN "workflow_status" fs
          ON fs."project_id" = w2."projectId" AND fs."key" = (r."diff" -> 'status' ->> 'from')
        JOIN "workflow_status" ts
          ON ts."project_id" = w2."projectId" AND ts."key" = (r."diff" -> 'status' ->> 'to')
        WHERE r."changeKind" = 'updated'
          AND r."diff" -> 'status' IS NOT NULL
          AND ts."category" = 'done'
          AND (fs."category" IS NULL OR fs."category" <> 'done')
        GROUP BY 1
      )
      SELECT
        be."key" AS "bucket",
        AVG(EXTRACT(EPOCH FROM (be."periodEnd" - w."createdAt")) / 86400.0)::float8 AS "avgDays",
        COUNT(*)::int AS "openCount"
      FROM be
      JOIN "work_item" w
        ON w."projectId" = ${projectId}
       AND w."workspaceId" = ${workspaceId}
       AND w."archivedAt" IS NULL
       AND w."triagedAt" IS NULL
       AND w."createdAt" <= be."periodEnd"
       AND (${astSql})
      LEFT JOIN resolved rs ON rs."itemId" = w."id"
      WHERE rs."firstDoneAt" IS NULL OR rs."firstDoneAt" > be."periodEnd"
      GROUP BY 1
      ORDER BY 1
    `;
  },
};
