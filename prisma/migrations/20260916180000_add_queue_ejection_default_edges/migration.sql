-- ============================================================
-- Backfill the merge-queue EJECTION's three default edges (MOTIR-5630).
-- ============================================================
-- `docs/decisions/approval-gates.md` §4 THIRD AMENDMENT, decision 7. The default
-- workflow (lib/workflows/defaultWorkflow.ts, `DEFAULT_TRANSITIONS`) gains three
-- edges and NO status:
--
--   • `approved → implemented`  — a `manual` project's card the merge queue
--     ejected for a failure after a person approved it;
--   • `in_review → implemented` — the same for an `auto` project's card, which
--     never reaches `approved`;
--   • `implemented → approved`  — _Queue again_ on unchanged heads, reusing the
--     card's one decided approval gate. A HAND move into `approved` while an open
--     pull request delivers the card stays refused by §6d rule 2b, in
--     `applyStatusTransition`.
--
-- New projects get them from `seedDefaultWorkflow`, which iterates the constant.
-- This migration gives every EXISTING default-workflow project the same three.
--
-- ⚠️ EDGES ONLY — no status and no board column. All three endpoints are
-- statuses that already exist (`implemented` since 20260819090000, `approved`
-- since 20260911140000), so there is nothing new to map onto a board.
--
-- ⚠️ ALL THREE KEYS OR NOTHING. The pattern is 20260911140000's step 2 — the
-- pairs enumerated as VALUES, joined per project on status KEY, guarded by
-- NOT EXISTS — with one more guard: a project whose workflow does not carry ALL
-- of `approved`, `in_review` and `implemented` gets none of the three. That is
-- what leaves a CUSTOM workflow alone: a team that renamed or removed one of
-- those statuses has a lifecycle this migration cannot reason about, and adding
-- half of the ejection's edges to it would be worse than adding none.
--
-- Idempotent: a second run finds every edge and inserts zero rows. Ids are fresh
-- uuids (the columns are plain `text`), mirroring the migrations this one is
-- modelled on.
--
-- MEASURED (2026-09-16) on a private copy of the seeded dev database:
-- `prisma migrate deploy` + `pnpm db:seed` into `mc_5461` (2 projects, both
-- carrying all three keys). A freshly seeded project already has the three edges
-- from the constant, so the pre-MOTIR-5630 shape was reproduced by deleting them
-- (6 rows), and this file was then run twice. Per edge, counted with
--
--   SELECT fs.key || '→' || ts.key AS edge, COUNT(*)
--   FROM workflow_transition t
--   JOIN workflow_status fs ON fs.id = t.from_status_id
--   JOIN workflow_status ts ON ts.id = t.to_status_id
--   WHERE (fs.key, ts.key) IN (('approved','implemented'),
--                              ('in_review','implemented'),
--                              ('implemented','approved'))
--   GROUP BY 1;
--
--   run 1 inserted 6:  approved→implemented 2 · in_review→implemented 2 ·
--                      implemented→approved 2
--   run 2 inserted 0
--
-- On a deployed database the first run inserts one row per edge per project
-- carrying all three keys and not already holding that edge.
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
FROM (VALUES
  ('approved', 'implemented'),
  ('in_review', 'implemented'),
  ('implemented', 'approved')
) AS edge(from_key, to_key)
JOIN "workflow_status" fs ON fs."key" = edge.from_key
JOIN "workflow_status" ts ON ts."project_id" = fs."project_id" AND ts."key" = edge.to_key
WHERE (
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
