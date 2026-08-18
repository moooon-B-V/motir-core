-- MOTIR-2922: give a pull-request row the two facts a subsumption check needs and
-- the mirror has never carried — WHEN the merge landed, and WHAT it touched.
--
-- `merged_at` is the ordering fact. `updated_at` cannot serve it: a later
-- `check_suite`-driven upsert moves that column, so it answers "when did we last
-- hear about this PR", not "when did the work land" — and the question this
-- substrate exists for ("did this land AFTER that card was filed?") needs the
-- second one.
--
-- `changed_paths` is a COLUMN on the existing row rather than a child table, on
-- purpose: the shipped `github_pull_request` RLS policy then covers it unchanged,
-- and no consumer wants a path without its pull request. `changed_paths_truncated`
-- is what keeps the no-silent-caps rule — a capped capture SAYS it was capped, so
-- a consumer can never read a prefix as the whole list.
--
-- Existing rows are unaffected: both new nullable/defaulted columns are additive,
-- no shipped consumer selects them, and the Development-surface DTO enumerates
-- its fields explicitly. No FK, no index — the consumer reads these per work
-- item, at advisory-compute time, not in a hot path.
-- AlterTable
ALTER TABLE "github_pull_request" ADD COLUMN     "changed_paths" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "changed_paths_truncated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "merged_at" TIMESTAMP(3);
