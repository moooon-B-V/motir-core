-- Monitor issue CONTEXT (Story MOTIR-4932 · Subtask MOTIR-5729): the two facts
-- the work-item page's Errors section promises and nothing recorded until now —
-- where the error is happening, and in which build. EXPAND-ONLY: two nullable
-- columns on the table MOTIR-5576 shipped; no rename, no backfill, no index.
--
-- ── WHAT THEY HOLD ─────────────────────────────────────────────────────────────
-- The issue's LATEST EVENT's `environment` tag and release version, as last
-- read. Sentry's issue list carries neither, so the reconciling poll reads them
-- one issue at a time, OUTSIDE the row lock, and writes them in the same update
-- that stores the other facts. `NULL` means "the latest event carried none, or
-- we have never read it" — a link that existed before this deploy reads `NULL`
-- until its next visit, which the Errors section shows as simply absent.
--
-- ── RLS is UNCHANGED ─────────────────────────────────────────────────────────
-- The columns ride the existing `monitor_issue_workspace_or_system` policy
-- (row-level, not column-level), so this migration touches no policy.

-- AlterTable
ALTER TABLE "monitor_issue" ADD COLUMN     "environment" TEXT,
ADD COLUMN     "release" TEXT;
