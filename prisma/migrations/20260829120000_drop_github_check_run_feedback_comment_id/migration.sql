-- ===========================================================================
-- CONTRACT — drop `github_check_run.feedback_comment_id` (MOTIR-3803 ·
-- `docs/decisions/ci-feedback-comment-per-card.md` ·
-- `docs/decisions/delivery-reader-migration.md` §6a).
--
-- `GithubCiFeedbackComment` (MOTIR-3770) is now the ONLY answer to *which
-- comment carries this card's CI verdict at this commit*. That table is keyed
-- `(pull_request_id, commit_sha, work_item_id)`, so it holds one row per
-- DELIVERED CARD; this column was a nullable scalar on a table whose grain is one
-- row per CHECK, and it could therefore name the comment of exactly one card on a
-- pull request that delivered N.
--
-- ⚠️ THIS IS THE THIRD PHASE OF THREE, AND THE ORDER IS THE WHOLE POINT.
--
--   1. EXPAND       (MOTIR-3770, 20260828190000) added the table and backfilled it.
--   2. SCHEMA-ONLY  (MOTIR-3863) took the field out of the GENERATED CLIENT with
--                   `@ignore` while leaving the column — and RELEASED it.
--   3. CONTRACT     (this) drops the column, and deletes the `@ignore`d field in
--                   the same commit.
--
-- The model DECLARATION is itself a reader: a bare relation include emits every
-- scalar the model names, so removing the field is what stops the client
-- selecting the column — and `fly.toml`'s `release_command` runs
-- `prisma migrate deploy` BEFORE any new machine takes traffic. Field-removal and
-- DROP in one release therefore leaves an interval in which the still-serving
-- previous image asks for a column that is gone. That is MOTIR-3852, which
-- 500-ed `get_work_item` tenant-wide for about six minutes.
--
-- The marker below is `tests/contract-phase-guard.test.ts`'s declaration that
-- phase 2 has actually SHIPPED AND RELEASED. It is not a formality here: the
-- release was verified against the platform by MOTIR-3864, which read every
-- machine's image tag and the deployed client's own datamodel.
-- @client-stopped-selecting: MOTIR-3863
--
-- Verified on release v191 (`deployment-01M16PKEWXJWHPMZSCZXPJBY48`,
-- 2026-08-29T12:11:11Z) before this migration was written:
--   • all 4 machines (app ×2, worker ×2, started and stopped) on that one tag;
--   • the deployed datamodel's `GithubCheckRun` field list carries no
--     `feedbackCommentId`, in the Next chunks AND in `worker.mjs`;
--   • the column still present, and the orphan count below already 0 of 44 577.
--
-- ⚠️ A DROP IS NOT REVERSIBLE BY A CODE REVERT, so the backfill is re-run once
-- more here. Pass 1 ran in 20260828190000 and every write path has since written
-- the per-card row instead of this column, so the expected count is ZERO — it is
-- re-run because "expected zero" is an argument, and this is the last moment at
-- which the column can be read at all. Same statement as pass 1, idempotent by
-- the unique index.
--
-- RLS: `github_ci_feedback_comment` is FORCE RLS and its policy admits
-- `app.system_admin = 'true'` (20260828190000). The migration role is subject to
-- the policy like any other, so the flag is set for this transaction rather than
-- the policy being weakened. `SET LOCAL` unsets it at commit.
-- ===========================================================================

SET LOCAL "app.system_admin" = 'true';

DO $$
DECLARE
  rescued integer;
BEGIN
  INSERT INTO "github_ci_feedback_comment" ("id", "pull_request_id", "commit_sha", "work_item_id", "comment_id", "created_at", "updated_at")
  SELECT DISTINCT ON (cr."pull_request_id", cr."commit_sha", c."work_item_id")
         gen_random_uuid()::text,
         cr."pull_request_id",
         cr."commit_sha",
         c."work_item_id",
         c."id",
         c."created_at",
         CURRENT_TIMESTAMP
  FROM "github_check_run" cr
  JOIN "comment" c ON c."id" = cr."feedback_comment_id"
  WHERE cr."feedback_comment_id" IS NOT NULL
  ORDER BY cr."pull_request_id", cr."commit_sha", c."work_item_id", cr."created_at"
  ON CONFLICT ("pull_request_id", "commit_sha", "work_item_id") DO NOTHING;

  GET DIAGNOSTICS rescued = ROW_COUNT;

  -- A NON-ZERO count is a FINDING, not a success: it means something wrote the
  -- legacy column without writing a per-card row after 20260828190000, and the
  -- pull request that did it should be found. A NOTICE so it lands in the
  -- `migrate deploy` log rather than being a number one laptop saw.
  RAISE NOTICE 'MOTIR-3803: % legacy feedback-comment link(s) had no github_ci_feedback_comment row and were carried over before the drop (expected 0)', rescued;
END
$$;

-- DropForeignKey
ALTER TABLE "github_check_run" DROP CONSTRAINT "github_check_run_feedback_comment_id_fkey";

-- AlterTable
ALTER TABLE "github_check_run" DROP COLUMN "feedback_comment_id";
