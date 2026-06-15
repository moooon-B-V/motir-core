-- Retire the dropped external-submitter intake (Subtask 6.11.10). The
-- unauthenticated public portal is dropped (Yue 2026-06-14 — a work item is
-- created only by a signed-in account), so triage attribution is ALWAYS a real
-- `submittedByUserId`. The captured-external name/email columns added by
-- 20260613221114_add_work_item_triage_marker are dead; drop them. The
-- `submittedByUserId` relation, `triagedAt`, and `snoozedUntil` are unchanged.
--
-- ORDERING (must land AFTER 20260615120000_repair_work_item_triage_marker_columns).
-- That hotfix (PR #1151) re-adds externalSubmitterName/Email with `IF NOT EXISTS`
-- to repair a production drift. This drop is timestamped 130000 so the replay
-- order on a fresh DB is add (6.11.3) → repair re-add (no-op) → DROP here — final
-- state: columns gone, matching this PR's schema.prisma. A 010000 timestamp (the
-- original) would run the drop BEFORE the repair, which would then re-add the
-- columns and re-introduce the drift.
--
-- IDEMPOTENT (`IF EXISTS`): on prod the repair already added the columns so the
-- drop removes them; on any environment where they're already absent the drop is
-- a no-op — robust regardless of which repair/drift state the target DB is in.

-- AlterTable
ALTER TABLE "work_item" DROP COLUMN IF EXISTS "externalSubmitterEmail";
ALTER TABLE "work_item" DROP COLUMN IF EXISTS "externalSubmitterName";
