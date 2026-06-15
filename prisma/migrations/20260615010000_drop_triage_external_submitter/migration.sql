-- Retire the dropped external-submitter intake (Subtask 6.11.10). The
-- unauthenticated public portal is dropped (Yue 2026-06-14 — a work item is
-- created only by a signed-in account), so triage attribution is ALWAYS a real
-- `submittedByUserId`. The captured-external name/email columns added by
-- 20260613221114_add_work_item_triage_marker are dead; drop them. The
-- `submittedByUserId` relation, `triagedAt`, and `snoozedUntil` are unchanged.

-- AlterTable
ALTER TABLE "work_item" DROP COLUMN "externalSubmitterEmail",
DROP COLUMN "externalSubmitterName";
