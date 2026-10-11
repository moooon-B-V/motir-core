-- Story MOTIR-7905 · MOTIR-7908 — A planning session's WAITING STATE as data.
--
-- An OPEN session can be waiting on its person in one of two ways, and never both:
--   * FAILED, waiting to resume — its latest hosted attempt failed partway through a
--     walk. The record is `failed_at` / `failed_job_id` / `failure_reason` plus the
--     stop point (`failure_stop_*`) and motir-ai's detail for support.
--   * AWAITING ITS PERSON — the conversation waits on its owner's next turn
--     (`awaiting_person_since` / `awaiting_person_cause`).
--
-- ADDITIVE ONLY: three enum types, nine NULLABLE columns with no default and no
-- backfill (no existing row is in either state), one index for the To resume read,
-- and three CHECK constraints as the database backstop for the invariants. NO RLS
-- policy is added: these are columns on a table whose existing policies already
-- cover the row.

-- CreateEnum
CREATE TYPE "plan_session_failure_reason" AS ENUM ('rate_limited', 'out_of_credits', 'model_unavailable', 'token_expired', 'internal');

-- CreateEnum
CREATE TYPE "plan_session_walk_phase" AS ENUM ('lay', 'author');

-- CreateEnum
CREATE TYPE "plan_session_awaiting_cause" AS ENUM ('question', 'reply');

-- AlterTable
ALTER TABLE "plan_change_session" ADD COLUMN     "awaiting_person_cause" "plan_session_awaiting_cause",
ADD COLUMN     "awaiting_person_since" TIMESTAMP(3),
ADD COLUMN     "failed_at" TIMESTAMP(3),
ADD COLUMN     "failed_job_id" TEXT,
ADD COLUMN     "failure_detail" TEXT,
ADD COLUMN     "failure_reason" "plan_session_failure_reason",
ADD COLUMN     "failure_stop_phase" "plan_session_walk_phase",
ADD COLUMN     "failure_stop_ref" TEXT,
ADD COLUMN     "failure_stop_title" TEXT;

-- CreateIndex
CREATE INDEX "plan_change_session_workspace_id_created_by_id_failed_at_idx" ON "plan_change_session"("workspace_id", "created_by_id", "failed_at");


-- AddConstraint: a failure record is WHOLE or absent. `failure_detail` and the stop
-- columns stay optional (an attempt can fail before the walk reached a level), but a
-- failed session always has a time, a job to resume from and a reason.
ALTER TABLE "plan_change_session"
  ADD CONSTRAINT "plan_change_session_failure_whole"
  CHECK (
    ("failed_at" IS NULL AND "failed_job_id" IS NULL AND "failure_reason" IS NULL)
    OR ("failed_at" IS NOT NULL AND "failed_job_id" IS NOT NULL AND "failure_reason" IS NOT NULL)
  );

-- AddConstraint: an awaiting record is WHOLE or absent.
ALTER TABLE "plan_change_session"
  ADD CONSTRAINT "plan_change_session_awaiting_whole"
  CHECK (
    ("awaiting_person_since" IS NULL AND "awaiting_person_cause" IS NULL)
    OR ("awaiting_person_since" IS NOT NULL AND "awaiting_person_cause" IS NOT NULL)
  );

-- AddConstraint: the two waits exclude each other, and an ENDED session waits on
-- nothing — which is why the one end write clears all nine columns.
ALTER TABLE "plan_change_session"
  ADD CONSTRAINT "plan_change_session_one_wait"
  CHECK (
    ("failed_at" IS NULL OR "awaiting_person_since" IS NULL)
    AND ("ended_at" IS NULL OR ("failed_at" IS NULL AND "awaiting_person_since" IS NULL))
  );
