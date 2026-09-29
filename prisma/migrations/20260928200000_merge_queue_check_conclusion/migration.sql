-- A merge-queue check's RAW conclusion (Story MOTIR-6843 · MOTIR-6846;
-- `docs/decisions/approval-gates.md` §4 SIXTH AMENDMENT). `mapConclusion` folds
-- `cancelled` and `timed_out` into `failure`, so the attempt and the exit kept the
-- check's NAME and lost how it ended. Nullable, no backfill: an exit recorded before
-- this reads as "no conclusion recorded", which the reconcile tick fills from GitHub.
ALTER TABLE "github_merge_queue_attempt" ADD COLUMN "failing_check_conclusion" TEXT;
ALTER TABLE "github_pull_request_queue_exit" ADD COLUMN "failing_check_conclusion" TEXT;
