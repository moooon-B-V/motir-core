-- MOTIR-4593 (Story MOTIR-4335): record why indexing is paused for a repository —
-- a dispatch refused by a hard stop of the organisation's internal index
-- allowance. Nullable, no backfill: every existing row is "not paused".
ALTER TABLE "github_repo" ADD COLUMN "index_paused_reason" TEXT;
ALTER TABLE "github_repo" ADD COLUMN "index_paused_at" TIMESTAMP(3);
