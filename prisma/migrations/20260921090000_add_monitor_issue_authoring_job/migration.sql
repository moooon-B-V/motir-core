-- Monitor issue AUTHORING JOB (Story MOTIR-4930 · Subtask MOTIR-5849): the id of
-- the motir-ai `author_bug` job dispatched to plan the bug filed for this issue.
-- EXPAND-ONLY: one nullable column on the table MOTIR-5576 shipped; no rename, no
-- backfill, no index.
--
-- ── WHAT IT HOLDS ──────────────────────────────────────────────────────────────
-- `NULL` means the filed bug was never offered enrichment — every link that
-- existed before this deploy, and every link whose bug was filed by hand. The
-- enrichment trigger dispatches only while it is `NULL` and writes the job id in
-- the same breath, which is what makes a redelivered `work-item/created` event
-- free rather than a second model call.
--
-- ── RLS is UNCHANGED ─────────────────────────────────────────────────────────
-- The column rides the existing `monitor_issue_workspace_or_system` policy
-- (row-level, not column-level), so this migration touches no policy.

-- AlterTable
ALTER TABLE "monitor_issue" ADD COLUMN     "authoring_job_id" TEXT;
