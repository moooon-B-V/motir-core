-- AlterTable
ALTER TABLE "work_item" ADD COLUMN     "sessionBranch" TEXT;

-- CreateIndex
CREATE INDEX "work_item_sessionBranch_idx" ON "work_item"("sessionBranch");

-- ============================================================
-- Backfill the `in_review → blocked` default-workflow transition (Subtask 7.8.11).
-- ============================================================
-- 7.8.11 adds ONE edge to the default workflow's transition graph:
-- `in_review → blocked` (lib/workflows/defaultWorkflow.ts). The `in_review` and
-- `blocked` statuses themselves already exist in every project's default
-- workflow (seeded since 2.2.2), as do the rest of the in_review edges — only
-- this one edge is new, so this is the only thing that needs backfilling into
-- EXISTING projects (new projects get the full graph from `seedDefaultWorkflow`).
--
-- Insert the edge for every project that has BOTH a default-keyed `in_review`
-- status AND a default-keyed `blocked` status and does not already carry the
-- edge. The `key`-based join leaves CUSTOM workflows untouched: a project that
-- renamed/removed either status (its key is no longer 'in_review'/'blocked')
-- simply doesn't match. Id is a fresh uuid (the column is plain `text`; mixing a
-- uuid with the app's cuids is fine — it's just a unique PK), mirroring the
-- data-backfill pattern in 20260613120000_add_organization_tier.
INSERT INTO "workflow_transition" (
  "id", "workspace_id", "project_id", "from_status_id", "to_status_id", "created_at"
)
SELECT
  gen_random_uuid()::text,
  fs."workspace_id",
  fs."project_id",
  fs."id",
  ts."id",
  CURRENT_TIMESTAMP
FROM "workflow_status" fs
JOIN "workflow_status" ts
  ON ts."project_id" = fs."project_id"
 AND ts."key" = 'blocked'
WHERE fs."key" = 'in_review'
  AND NOT EXISTS (
    SELECT 1 FROM "workflow_transition" t
    WHERE t."project_id" = fs."project_id"
      AND t."from_status_id" = fs."id"
      AND t."to_status_id" = ts."id"
  );
