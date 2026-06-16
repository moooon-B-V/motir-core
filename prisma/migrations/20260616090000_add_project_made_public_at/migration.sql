-- Story 6.13 · Subtask 6.13.4 — the project square's Recent/New rank orders by
-- the moment a project became public. Add the nullable `made_public_at` column
-- (`Project.madePublicAt`); existing rows backfill to NULL with no data step
-- (the Recent rank COALESCEs NULL to `created_at`).
ALTER TABLE "project" ADD COLUMN "made_public_at" TIMESTAMP(3);
