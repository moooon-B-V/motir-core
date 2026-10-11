-- Story MOTIR-8128 · MOTIR-8132 — a failure record may name NO job.
--
-- The abandoned-plan sweep now RECORDS a silent plan's failure on its open
-- `conversation` / `mcp` session instead of declining the plan, and an MCP-authored
-- plan has no generation job by construction (`create_plan`). Its record carries
-- `failed_job_id` NULL: To resume lists it, Resume (which needs a job to resume
-- from) is not offered, and the producer resumes by writing again.
--
-- `plan_change_session_failure_whole` required the job id on every failure, so it is
-- re-stated without it. A failure is still WHOLE or absent on the two columns that
-- define one (`failed_at`, `failure_reason`), and a cleared record still clears the
-- job id with them. The column was already nullable; nothing else changes.

ALTER TABLE "plan_change_session" DROP CONSTRAINT "plan_change_session_failure_whole";

ALTER TABLE "plan_change_session"
  ADD CONSTRAINT "plan_change_session_failure_whole"
  CHECK (
    ("failed_at" IS NULL AND "failed_job_id" IS NULL AND "failure_reason" IS NULL)
    OR ("failed_at" IS NOT NULL AND "failure_reason" IS NOT NULL)
  );
