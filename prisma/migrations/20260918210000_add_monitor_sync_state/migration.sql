-- Monitor SYNC state (Story MOTIR-4931 · Subtask MOTIR-5701) — the persisted
-- state resolve-back and the assignee sync read and write, on the two tables
-- MOTIR-5576 shipped. EXPAND-ONLY: new nullable or defaulted columns and one
-- index; no rename, no backfill, no new table.
--
-- ── THE DEFAULTS ARE THE STORY'S SHIPPED DEFAULT, DELIBERATELY ──────────────
-- `resolve_on_done` and `sync_assignee` are `NOT NULL DEFAULT true`, so every
-- connection bound before this migration resolves on done and takes assignees
-- after the deploy. The first poll's backstop sweep therefore resolves every
-- link whose bug is ALREADY done — those bugs were fixed and the monitor still
-- calls them unresolved. A team that does not want that turns the switch off.
--
-- ── `resolved_by_motir_at` IS THE LOOP GUARD'S INPUT ───────────────────────
-- Recorded on the MOTIR side, never read off the provider's actor: on a shared
-- credential "we resolved it" and "they resolved it" are the same identity to
-- the provider. An issue last seen at or before this moment is one Motir itself
-- closed, and the reconciler treats it as already reconciled.
--
-- ── RLS is UNCHANGED ─────────────────────────────────────────────────────────
-- The new columns ride the existing `monitor_connection_workspace_or_system` and
-- `monitor_issue_workspace_or_system` policies (row-level, not column-level), so
-- this migration touches no policy.

-- AlterTable
ALTER TABLE "monitor_connection" ADD COLUMN     "last_sync_error" TEXT,
ADD COLUMN     "last_sync_error_at" TIMESTAMP(3),
ADD COLUMN     "last_sync_error_work_item_identifier" TEXT,
ADD COLUMN     "resolve_on_done" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "sync_assignee" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "monitor_issue" ADD COLUMN     "assignee_checked_at" TIMESTAMP(3),
ADD COLUMN     "assignee_sync_note" TEXT,
ADD COLUMN     "resolve_attempted_at" TIMESTAMP(3),
ADD COLUMN     "resolve_error" TEXT,
ADD COLUMN     "resolve_state" TEXT,
ADD COLUMN     "resolved_by_motir_at" TIMESTAMP(3),
ADD COLUMN     "synced_assignee_external_id" TEXT;

-- CreateIndex
CREATE INDEX "monitor_issue_connection_id_assignee_checked_at_idx" ON "monitor_issue"("connection_id", "assignee_checked_at");

