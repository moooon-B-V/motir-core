-- Monitor issue EVIDENCE (Story MOTIR-5975 · Subtask MOTIR-5979): the latest
-- event's exception, stack frames, tags, request line and identity, KEPT on the
-- link so the work-item page, `get_work_item` and the dispatch prompt can render
-- it without calling the provider. EXPAND-ONLY: ten nullable columns on the
-- table MOTIR-5576 shipped; no rename, no backfill, no default, no index.
--
-- ── WHAT THEY HOLD ─────────────────────────────────────────────────────────────
-- What the latest event said, as last read successfully by the reconciling poll
-- or the hand-made link. `frames` / `tags` NULL means "never read"; `[]` means
-- "read, and there were none". `evidence_read_at` is the last SUCCESSFUL read
-- and `evidence_checked_at` the last ATTEMPT, so a checked-after-read row is
-- STALE — the last check failed and the evidence shown is older. A link that
-- existed before this deploy reads NULL throughout until the standing backfill
-- sweep (MOTIR-5983) or its next visit reads it.
--
-- The tags have already been through the user-identifying filter and the
-- request is a method and a PATH only; nothing personal is written here.
--
-- ── RLS is UNCHANGED ─────────────────────────────────────────────────────────
-- The columns ride the existing `monitor_issue_workspace_or_system` policy
-- (row-level, not column-level), so this migration touches no policy.

-- AlterTable
ALTER TABLE "monitor_issue" ADD COLUMN     "event_at" TIMESTAMP(3),
ADD COLUMN     "event_id" TEXT,
ADD COLUMN     "evidence_checked_at" TIMESTAMP(3),
ADD COLUMN     "evidence_read_at" TIMESTAMP(3),
ADD COLUMN     "exception_message" TEXT,
ADD COLUMN     "exception_type" TEXT,
ADD COLUMN     "frames" JSONB,
ADD COLUMN     "request_method" TEXT,
ADD COLUMN     "request_path" TEXT,
ADD COLUMN     "tags" JSONB;
