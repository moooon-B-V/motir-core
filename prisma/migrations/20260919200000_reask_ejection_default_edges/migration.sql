-- ============================================================
-- A merge-queue FAILURE ejection RE-ASKS the merge question (MOTIR-5804).
-- ============================================================
-- `docs/decisions/approval-gates.md` §4 FOURTH AMENDMENT, point 6. The default
-- workflow (lib/workflows/defaultWorkflow.ts, `DEFAULT_TRANSITIONS`) changes by
-- two edges and NO status:
--
--   • `approved → in_review`    — DECLARED. A `manual` project's card the merge
--     queue ejected for a failure goes back to review, where ONE fresh
--     approve-to-merge gate asks the person again;
--   • `implemented → approved`  — REMOVED. An approval is only ever given from
--     `in_review`. Its only product writer was _Queue again_ reusing the old
--     approval, which MOTIR-5802 retired.
--
-- `approved → implemented` and `in_review → implemented` are NOT touched.
--
-- New projects get the new set from `seedDefaultWorkflow` / `restoreDefaultTransitions`,
-- which iterate the constant. This migration converges every EXISTING
-- default-workflow project.
--
-- ⚠️ THE KEYS DECIDE THE POPULATION, exactly as 20260916180000 did. Both halves
-- act only on a project whose workflow carries ALL of `approved`, `in_review` and
-- `implemented` — the population MOTIR-5630's backfill wrote `implemented →
-- approved` into. A team that renamed or removed one of those statuses has a
-- lifecycle this migration cannot reason about, and it is left alone. Motir does
-- not decide how a team works.
--
-- ⚠️ WHAT THE DELETE MAY REMOVE — measured on production before it was written.
-- Read-only, from inside the `motir-core` machine as the table owner
-- (`BEGIN READ ONLY … ROLLBACK`), 2026-09-19:
--
--   SELECT count(*), min(t.created_at), max(t.created_at),
--          count(DISTINCT t.created_at)
--   FROM workflow_transition t
--   JOIN workflow_status f ON f.id = t.from_status_id
--   JOIN workflow_status s ON s.id = t.to_status_id
--   WHERE f.key = 'implemented' AND s.key = 'approved';
--
--   → 15 rows, min = max = 2026-09-16T23:18:16.817Z, 1 distinct instant
--     (the single instant 20260916180000's backfill ran). 15 projects carry all
--     three keys; `approved → in_review` existed 0 times.
--
-- So every `implemented → approved` row on production is Motir's own backfill,
-- none is a person's, and no project seeded since carries one. The delete is
-- therefore scoped by the three-key population rather than by timestamp — a
-- timestamp would also miss the same edge `seedDefaultWorkflow` wrote into a
-- project created on another deployment between 2026-09-16 and this release.
--
-- Idempotent: a second run inserts and deletes zero rows.
--
-- MEASURED (2026-09-19) on a private copy of the seeded dev database:
-- `prisma migrate deploy` + `pnpm db:seed` into `mc_5804` (2 projects, both
-- carrying all three keys). A freshly seeded project already has the new set
-- from the constant, so the pre-release shape was reproduced by deleting
-- `approved → in_review` and re-running 20260916180000 (which re-adds
-- `implemented → approved`: 2 rows). This file's two statements were then run
-- twice. Per edge:
--
--   run 1: inserted approved→in_review 2 · deleted implemented→approved 2
--   run 2: inserted 0 · deleted 0

-- 1 · DECLARE `approved → in_review` on every three-key project that lacks it.
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
JOIN "workflow_status" ts ON ts."project_id" = fs."project_id" AND ts."key" = 'in_review'
WHERE fs."key" = 'approved'
  AND (
    SELECT COUNT(DISTINCT s."key") FROM "workflow_status" s
    WHERE s."project_id" = fs."project_id"
      AND s."key" IN ('approved', 'in_review', 'implemented')
  ) = 3
  AND NOT EXISTS (
    SELECT 1 FROM "workflow_transition" t
    WHERE t."project_id" = fs."project_id"
      AND t."from_status_id" = fs."id"
      AND t."to_status_id" = ts."id"
  );

-- 2 · REMOVE `implemented → approved` from the same population.
DELETE FROM "workflow_transition" t
USING "workflow_status" fs, "workflow_status" ts
WHERE t."from_status_id" = fs."id"
  AND t."to_status_id" = ts."id"
  AND fs."key" = 'implemented'
  AND ts."key" = 'approved'
  AND fs."project_id" = t."project_id"
  AND ts."project_id" = t."project_id"
  AND (
    SELECT COUNT(DISTINCT s."key") FROM "workflow_status" s
    WHERE s."project_id" = t."project_id"
      AND s."key" IN ('approved', 'in_review', 'implemented')
  ) = 3;
