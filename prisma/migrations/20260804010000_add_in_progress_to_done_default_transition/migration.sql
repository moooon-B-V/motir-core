-- ============================================================
-- Backfill the `in_progress → done` default-workflow transition (MOTIR-1625).
-- ============================================================
-- MOTIR-1625 adds ONE edge to the default workflow's transition graph:
-- `in_progress → done` (lib/workflows/defaultWorkflow.ts), making the review hop
-- OPTIONAL rather than mandatory. Both statuses already exist in every project's
-- default workflow (seeded since 2.2.2), so this single edge is the only thing
-- that needs backfilling into EXISTING projects — new projects get the full
-- graph from `seedDefaultWorkflow`.
--
-- Two consumers need it: a project with no review gate (the Epic-9 configurable
-- review step), and MOTIR-1615's upward status rollup, whose "all children done
-- ⇒ parent done" rung fires on parents that are `in_progress`, never `in_review`
-- — without this edge that move is illegal and the rollup strands the parent.
--
-- Insert the edge for every project that has BOTH a default-keyed `in_progress`
-- status AND a default-keyed `done` status and does not already carry the edge.
-- The `key`-based join leaves CUSTOM workflows untouched: a project that
-- renamed/removed either status (its key is no longer 'in_progress'/'done')
-- simply doesn't match. Idempotent via the NOT EXISTS guard. Id is a fresh uuid
-- (the column is plain `text`; mixing a uuid with the app's cuids is fine — it's
-- just a unique PK), mirroring 20260615005304_add_work_item_session_branch,
-- which backfilled 7.8.11's `in_review → blocked` edge exactly this way.
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
 AND ts."key" = 'done'
WHERE fs."key" = 'in_progress'
  AND NOT EXISTS (
    SELECT 1 FROM "workflow_transition" t
    WHERE t."project_id" = fs."project_id"
      AND t."from_status_id" = fs."id"
      AND t."to_status_id" = ts."id"
  );
