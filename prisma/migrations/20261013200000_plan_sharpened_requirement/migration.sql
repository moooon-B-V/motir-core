-- Task MOTIR-1101 · Subtask MOTIR-8183 — a plan can hold the requirement a
-- Sharpen session settled. Additive and nullable: no backfill (NULL means "never
-- sharpened"), and no RLS change, because the column sits on `plan`, which is
-- already workspace-scoped by its existing policy.
ALTER TABLE "plan" ADD COLUMN "sharpened_requirement" JSONB;
