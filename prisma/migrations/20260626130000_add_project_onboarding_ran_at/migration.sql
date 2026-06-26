-- The immutable onboarding-ran marker on the project (Subtask 7.4 / MOTIR-1264):
-- stamped ONCE, with the approval timestamp, when the project's FIRST `Plan` is
-- approved + materialized, then never cleared (a null-guarded `updateMany` in
-- the repository is the set-once guard). NULL = the project never onboarded (a
-- `db:seed` tree or a migrate-existing project), so every existing project
-- backfills to NULL with no data step. Read by the `/onboarding` redirect AND
-- the roadmap planning-origin cluster (MOTIR-1013).
-- AlterTable
ALTER TABLE "project" ADD COLUMN     "onboarding_ran_at" TIMESTAMP(3);
