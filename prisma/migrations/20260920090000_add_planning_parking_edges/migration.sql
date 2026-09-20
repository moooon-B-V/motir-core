-- ============================================================
-- Backfill the PLANNING PARKING edges (MOTIR-5643, bug MOTIR-5640).
-- ============================================================
-- `docs/decisions/agent-authored-plans.md` AMENDMENT 16 (the PLAN-TARGET STATUS
-- contract) decides that a plan PARKS every committed target it names, from any
-- NON-terminal status, and that approving the plan rests each parked target at
-- `blocked` or `todo`. D10 is the edge half of that decision.
--
-- What is missing without it: `lib/workflows/defaultWorkflow.ts` declared only
-- `todo → planning` and `in_progress → planning`, so a `blocked`, `implemented`,
-- `in_review` or `approved` card could not be parked at all — not by the product
-- and not by a person — and there was no `planning → blocked` for the approve to
-- write its Blocked answer on. New projects get all five from
-- `seedDefaultWorkflow`; this migration is what stops every EXISTING project
-- from being left with a graph that cannot express the states the product is
-- about to start writing.
--
-- ⚠️ NO NEW STATUS, so ONE write and not three. `planning` (20260807220000) and
-- `blocked` already exist on every default-workflow project, and both already
-- have a board column. This adds EDGES between statuses that are already there,
-- which is the same shape 20260916180000_add_queue_ejection_default_edges has
-- and for the same reason.
--
-- ⚠️ NOTHING FROM `done` OR `cancelled`, deliberately (AMENDMENT 16 D2; product
-- owner, 2026-09-16). We plan forward: a terminal card is superseded by a new
-- one rather than re-planned in place, and `lib/plans/validateProposals.ts`
-- already refuses a terminal target with `PlanTargetImmutableError` before any
-- status is written. The pair is absent from this file AND from
-- `DEFAULT_TRANSITIONS`, and `tests/workflows/planning-parking-edges.test.ts`
-- asserts both absences so neither can be added by accident.
--
-- ── MEASURED ────────────────────────────────────────────────────────────────
-- On a PRIVATE scratch Postgres (`pgvector/pgvector:pg16`,
-- `POSTGRES_INITDB_ARGS=--locale=C.UTF-8`, production's pinned collation), with
-- every migration up to this one applied and `pnpm db:seed` run, then the five
-- edges deleted to reproduce a pre-migration project:
--
--   docker run -d --name motir-core-pg-5640 -e POSTGRES_USER=prodect \
--     -e POSTGRES_PASSWORD=prodect -e POSTGRES_DB=prodect \
--     -e POSTGRES_INITDB_ARGS='--locale=C.UTF-8' \
--     -p 127.0.0.1:5445:5432 pgvector/pgvector:pg16
--   pnpm prisma migrate deploy && pnpm db:seed
--   psql -tAc "SELECT p.id, count(t.id) FROM project p
--                JOIN workflow_transition t ON t.project_id = p.id GROUP BY p.id"
--
-- The seeded database carries TWO projects with a workflow, each at 41
-- transitions with the amended constant and at 36 with these five removed.
-- Applying this file inserted, per edge, ONE row per project:
--
--   blocked     -> planning : 2
--   implemented -> planning : 2
--   in_review   -> planning : 2
--   approved    -> planning : 2
--   planning    -> blocked  : 2
--   TOTAL                   : 10   (both projects back to 41)
--
-- A second run inserted 0, which is the NOT EXISTS guard below doing its job.
-- The same three cases are asserted against real Postgres, per project shape, in
-- `tests/workflows/planning-parking-edges.test.ts` — this tally is the record of
-- what was observed, and that test is what keeps it true.
--
-- The `key`-based join leaves CUSTOM workflows untouched: a project that renamed
-- or removed `planning`, `blocked`, `implemented`, `in_review` or `approved`
-- simply does not match for the pairs that need the missing key, and gets fewer
-- edges — which is correct for a workflow somebody customised. The pairs are
-- enumerated rather than generated so this file states the same graph
-- `DEFAULT_TRANSITIONS` does, and a reader can compare them line for line.

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
  -- IN: the four non-terminal statuses that could not be parked before.
  ('blocked', 'planning'),
  ('implemented', 'planning'),
  ('in_review', 'planning'),
  ('approved', 'planning'),
  -- OUT: the resting status an approved plan writes when a live `blocked_by`
  -- of the parked card is still open (AMENDMENT 16 D6).
  ('planning', 'blocked')
) AS edge(from_key, to_key)
JOIN "workflow_status" fs ON fs."key" = edge.from_key
JOIN "workflow_status" ts ON ts."project_id" = fs."project_id" AND ts."key" = edge.to_key
WHERE NOT EXISTS (
  SELECT 1 FROM "workflow_transition" t
  WHERE t."project_id" = fs."project_id"
    AND t."from_status_id" = fs."id"
    AND t."to_status_id" = ts."id"
);
