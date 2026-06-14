import { Prisma, type EstimationStatistic, type WorkItem } from '@prisma/client';
import { db } from '@/lib/db';

// Data access for the `sprint_report_entry` table
// (bug-sprint-report-incomplete-list-zero-after-carry-over). Single-Prisma-op
// leaves per CLAUDE.md — no business logic, no DTO mapping, no transactions.
// Named by its primary entity (`sprint_report_entry`), not by call site.
//
// `sprint_report_entry` is the FROZEN at-completion snapshot of a sprint's
// report: `sprintsService.completeSprint` (4.4.3) writes one row per non-
// archived member issue when the sprint closes (BEFORE the carry-over moves the
// unfinished issues out), and `sprintsService.getSprintReport` (4.4.4/4.4.6)
// reads it for a `complete` sprint so the completed/incomplete split, counts,
// points, and "added during sprint" figure stay frozen at close even after
// carry-over re-points the issues' `sprintId`. Only the BUCKET (`completed`),
// the order (`backlogRank`), and the scope flag (`addedAfterStart`) are frozen;
// the issue ROW content is read LIVE through the `workItem` relation.
//
// TENANCY (finding #26): every read/write carries an explicit `workspaceId` —
// primary even under the dev/CI BYPASSRLS `db` role; the table's FORCE-RLS
// workspace policy is the backstop for the non-bypass `prodect_app` role the
// `completeSprint` write runs under.

/** The per-issue snapshot row `createSnapshot` inserts (the loader supplies the
 *  frozen bucket / order / scope flag). */
export interface SprintReportEntryInput {
  workspaceId: string;
  sprintId: string;
  workItemId: string;
  completed: boolean;
  addedAfterStart: boolean;
  backlogRank: string | null;
}

export const sprintReportEntryRepository = {
  /**
   * Bulk-insert a sprint's frozen report snapshot (one row per member issue at
   * close). Write → requires `tx` (it runs inside `completeSprint`'s carry-over
   * transaction, so a rollback leaves no partial snapshot). An empty `entries`
   * (a sprint with no non-archived issues) is a no-op `createMany` (returns 0) —
   * the empty-input guard the report read tolerates. `skipDuplicates` makes a
   * replayed completion (should never happen — `active→complete` is one-way)
   * idempotent on the `(sprintId, workItemId)` unique.
   */
  async createSnapshot(
    entries: SprintReportEntryInput[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (entries.length === 0) return 0;
    const result = await tx.sprintReportEntry.createMany({ data: entries, skipDuplicates: true });
    return result.count;
  },

  /**
   * Count of a completed sprint's snapshot rows in one done-category bucket
   * (`completed: true` → the COMPLETED count; `false` → the NOT-completed
   * count) — the grouped aggregate behind the frozen report's counts, never a
   * page sum. `workspaceId` gates the read.
   */
  async countByCompletion(
    sprintId: string,
    workspaceId: string,
    completed: boolean,
  ): Promise<number> {
    return db.sprintReportEntry.count({
      where: { sprintId, workspaceId, completed },
    });
  },

  /**
   * One bounded, cursor-paginated page of a completed sprint's snapshot issues
   * in one bucket — the frozen analogue of
   * `workItemRepository.findSprintIssuesByDoneMembership`. Returns the LIVE
   * `WorkItem` rows (joined through the snapshot) ordered by the FROZEN
   * `backlogRank` + `workItemId` tiebreak (the rank the issue had at close, so
   * a carry-over into another sprint that re-ranks the issue does not reorder
   * the closed report). Takes `take + 1` so the service can detect a next page;
   * the `cursor` is a work-item id (the same cursor contract the live read
   * uses). `workspaceId` gates the read.
   */
  async findByCompletion(
    sprintId: string,
    workspaceId: string,
    params: { completed: boolean; take: number; cursor?: string },
  ): Promise<WorkItem[]> {
    const { completed, take, cursor } = params;
    const rows = await db.sprintReportEntry.findMany({
      where: { sprintId, workspaceId, completed },
      orderBy: [{ backlogRank: 'asc' }, { workItemId: 'asc' }],
      include: { workItem: true },
      take: take + 1,
      ...(cursor
        ? { cursor: { sprintId_workItemId: { sprintId, workItemId: cursor } }, skip: 1 }
        : {}),
    });
    return rows.map((r) => r.workItem);
  },

  /**
   * Count of a completed sprint's snapshot issues that were ADDED to the sprint
   * after it started — the frozen "added during sprint" figure (the live
   * `workItemRevisionRepository.countItemsAddedToSprintAfter` undercounts a
   * closed sprint because the carried-over additions are no longer members).
   * `workspaceId` gates the read.
   */
  async countAddedAfterStart(sprintId: string, workspaceId: string): Promise<number> {
    return db.sprintReportEntry.count({
      where: { sprintId, workspaceId, addedAfterStart: true },
    });
  },

  /**
   * The frozen completed / not-completed POINT sums for a completed sprint — the
   * configured estimation `statistic` summed over the snapshot, split by the
   * FROZEN `completed` bucket (NOT the issue's live status). The analogue of
   * `workItemRepository.sumPointsForSprint`, but the membership + bucket come
   * from the snapshot so carry-over can't zero the not-completed figure. The
   * issue's point VALUE is read live (`story_points` / `time_estimate` /
   * `issue_count`), matching the live-row / frozen-grouping rule. One grouped
   * `$queryRaw`; `workspaceId` gates the read. A sprint with no snapshot rows
   * yields `{ completed: 0, notCompleted: 0 }` (the totals stay total).
   */
  async sumPointsByCompletion(
    sprintId: string,
    workspaceId: string,
    statistic: EstimationStatistic,
  ): Promise<{ completed: number; notCompleted: number }> {
    // The per-issue statistic value — an internal literal expression keyed off
    // the project's configured statistic, never user input (mirrors
    // `pointsAggExpr` in workItemRepository).
    const stat =
      statistic === 'issue_count'
        ? Prisma.sql`1`
        : statistic === 'story_points'
          ? Prisma.sql`COALESCE(w."storyPoints", 0)`
          : Prisma.sql`COALESCE(w."estimateMinutes", 0)`;
    const rows = await db.$queryRaw<Array<{ completed: number; not_completed: number }>>`
      SELECT COALESCE(SUM(${stat}) FILTER (WHERE e."completed"), 0)::float8 AS "completed",
             COALESCE(SUM(${stat}) FILTER (WHERE NOT e."completed"), 0)::float8 AS "not_completed"
        FROM "sprint_report_entry" e
        JOIN "work_item" w ON w."id" = e."work_item_id"
       WHERE e."sprint_id" = ${sprintId}
         AND e."workspace_id" = ${workspaceId}`;
    const row = rows[0] ?? { completed: 0, not_completed: 0 };
    return { completed: row.completed, notCompleted: row.not_completed };
  },
};
