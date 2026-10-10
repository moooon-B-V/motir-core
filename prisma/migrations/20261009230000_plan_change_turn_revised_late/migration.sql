-- A change forwarded after the walk finished is revised in, not dropped (Story
-- MOTIR-7990 · MOTIR-7997).
--
-- One NULLABLE column on `plan_change_turn`, no back-fill: a null reads exactly as it
-- did before. The table's RLS policies are row-level and unchanged.
--
--   revised_late_job_id   the REVISE_PLAN job a mid-run `user` turn became.

-- AlterTable
ALTER TABLE "plan_change_turn" ADD COLUMN     "revised_late_job_id" TEXT;
