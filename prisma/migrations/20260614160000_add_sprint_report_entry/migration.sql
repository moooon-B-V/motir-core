-- The FROZEN at-completion sprint-report snapshot
-- (bug-sprint-report-incomplete-list-zero-after-carry-over). Ships in one
-- atomic step (migration-by-concern, PRODECT_FINDINGS #20 — a table lands WITH
-- its RLS policy so there is never an unguarded window):
--   1. the `sprint_report_entry` table — one row per non-archived issue that was
--      a member of a sprint at the moment it COMPLETED, written by
--      `sprintsService.completeSprint` (Story 4.4.3) inside the carry-over
--      transaction, BEFORE the unfinished issues are moved out;
--   2. its indexes + FKs;
--   3. ENABLE + FORCE row-level security + the tenancy policy.
--
-- WHY: `getSprintReport` (Story 4.4.4/4.4.6) previously computed the
-- completed/incomplete split from the issues' CURRENT sprint membership
-- (`work_item.sprintId = <sprint>`). On a COMPLETED sprint that is wrong — the
-- carry-over has already cleared/re-pointed the unfinished issues' `sprintId`,
-- so the "Issues not completed" list + count (and the not-completed points + the
-- "added during sprint" figure) collapsed to 0. Jira freezes the sprint report
-- at close; this table is that frozen snapshot. The report reads it for a
-- `complete` sprint, while an `active`/`planned` sprint (the complete-modal live
-- preview) keeps reading live membership. Only the BUCKET (`completed`), the
-- order (`backlog_rank`), and the scope-change flag (`added_after_start`) are
-- frozen; the issue ROW content is read live through the `work_item` FK.
--
-- Delete semantics: `workspace_id` CASCADE (tenant teardown); `sprint_id`
-- CASCADE (a deleted sprint takes its snapshot with it); `work_item_id` CASCADE
-- (a hard-deleted issue's frozen rows go with it — the deep-link would 404
-- otherwise, the notification/comment precedent). All three FKs are modelled as
-- Prisma `@relation`s (forward field + back-relation) with these same actions,
-- so `migrate dev` reports "No difference detected" (the FK-drift rule,
-- bug-attachment-fk-migration-drift).
--
-- RLS: pure workspace gate (NON-NULL `workspace_id`), the SAME single PERMISSIVE
-- FOR ALL policy as `sprint` / `comment` / `notification`: USING + WITH CHECK
-- against `current_setting('app.workspace_id', true)` (`true` = missing_ok, so
-- an unset GUC yields NULL → predicate NULL → row hidden, the safe failure).
-- ENABLE + FORCE so even the table-owner `prodect` role is subject to it
-- (production + the completeSprint write connect as the non-BYPASSRLS
-- `prodect_app` role, PRODECT_FINDINGS #5). Grants: the workspace RLS
-- migration's `ALTER DEFAULT PRIVILEGES … TO prodect_app` auto-grants on every
-- NEW table created by the `prodect` role, so no explicit GRANT is needed (same
-- as sprint / comment / notification).

-- CreateTable
CREATE TABLE "sprint_report_entry" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "sprint_id" TEXT NOT NULL,
    "work_item_id" TEXT NOT NULL,
    "completed" BOOLEAN NOT NULL,
    "added_after_start" BOOLEAN NOT NULL,
    "backlog_rank" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sprint_report_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sprint_report_entry_sprint_id_completed_backlog_rank_work_i_idx" ON "sprint_report_entry"("sprint_id", "completed", "backlog_rank", "work_item_id");

-- CreateIndex
CREATE INDEX "sprint_report_entry_workspace_id_idx" ON "sprint_report_entry"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "sprint_report_entry_sprint_id_work_item_id_key" ON "sprint_report_entry"("sprint_id", "work_item_id");

-- AddForeignKey
ALTER TABLE "sprint_report_entry" ADD CONSTRAINT "sprint_report_entry_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sprint_report_entry" ADD CONSTRAINT "sprint_report_entry_sprint_id_fkey" FOREIGN KEY ("sprint_id") REFERENCES "sprint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sprint_report_entry" ADD CONSTRAINT "sprint_report_entry_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security — sprint_report_entry (pure workspace gate, no escape hatch)
-- ===========================================================================
ALTER TABLE "sprint_report_entry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sprint_report_entry" FORCE ROW LEVEL SECURITY;

CREATE POLICY "sprint_report_entry_active_workspace" ON "sprint_report_entry"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
