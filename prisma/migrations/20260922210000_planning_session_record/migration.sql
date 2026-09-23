-- MOTIR-6020 — a planning SESSION is a record, many per scope, and every plan
-- belongs to exactly one (story MOTIR-6011; the contract is
-- `docs/decisions/agent-authored-plans.md` AMENDMENT 17 §2, §4, §5).
-- ===========================================================================
-- ONE DEPLOY IS SAFE. The migration runs before the new build serves, so the
-- only build that can meet the relaxed schema is the OLD one — and the worst it
-- can do there is create a second session for a scope in a create race, which
-- the new model makes legal. The new build never meets the old schema.
-- `plan.session_id` stays NULLABLE for the same reason: an old build writing a
-- plan mid-rollout must not fail. RLS is unchanged — both tables keep their
-- workspace-scoped policies, and no new column adds a predicate.
--
-- ⚠️ `plan.session_id` is `ON DELETE NO ACTION`, not RESTRICT. A session is
-- only ever removed by the project / workspace cascade that removes its plans
-- in the SAME statement; RESTRICT is checked row by row as the cascade runs and
-- can fire before the plan row is gone, where NO ACTION is checked once, at the
-- end of the statement. Both refuse deleting a session a surviving plan points
-- at.

-- CreateEnum
CREATE TYPE "plan_session_origin" AS ENUM ('conversation', 'mcp', 'generation', 'expand', 'cadence', 'legacy');

-- DropIndex — the one-per-scope unique (MOTIR-909). A scope now holds many.
DROP INDEX "plan_change_session_project_id_scope_key_key";

-- AlterTable
ALTER TABLE "plan" ADD COLUMN     "session_id" TEXT;

-- AlterTable
ALTER TABLE "plan_change_session" ADD COLUMN     "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "origin" "plan_session_origin" NOT NULL DEFAULT 'conversation';

-- CreateIndex
CREATE INDEX "plan_session_id_idx" ON "plan"("session_id");

-- CreateIndex — the resume read (§3).
CREATE INDEX "plan_change_session_project_id_scope_key_created_by_id_last_idx" ON "plan_change_session"("project_id", "scope_key", "created_by_id", "last_activity_at");

-- CreateIndex — the Plans page's session list (§8).
CREATE INDEX "plan_change_session_project_id_last_activity_at_idx" ON "plan_change_session"("project_id", "last_activity_at");

-- AddForeignKey
ALTER TABLE "plan" ADD CONSTRAINT "plan_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "plan_change_session"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- ===========================================================================
-- BACKFILL — every statement below is IDEMPOTENT (guarded on the state it
-- creates), and `tests/integration/migrations/planning-session-record-backfill.test.ts`
-- runs exactly this section against a seeded fixture, twice.
-- ===========================================================================

-- 1) `last_activity_at` of every pre-existing CONVERSATION = the latest of its
--    newest turn, its last submit and its last write. Scoped to
--    `origin = 'conversation'` so a re-run never overwrites the synthetic
--    sessions step 3 dates from their plan.
UPDATE "plan_change_session" s
SET "last_activity_at" = GREATEST(
  s."updated_at",
  COALESCE(s."last_submitted_at", s."updated_at"),
  COALESCE(
    (SELECT max(t."created_at") FROM "plan_change_turn" t WHERE t."session_id" = s."id"),
    s."updated_at"
  )
)
WHERE s."origin" = 'conversation';

-- 2) A plan whose job is a session's LAST job joins that session — when exactly
--    one session in the plan's project matches. (The link is lossy: only the
--    latest submit of each session matches, which is the gap this closes.)
UPDATE "plan" p
SET "session_id" = s."id"
FROM "plan_change_session" s
WHERE p."session_id" IS NULL
  AND p."source_job_id" IS NOT NULL
  AND s."project_id" = p."project_id"
  AND s."last_job_id" = p."source_job_id"
  AND (
    SELECT count(*) FROM "plan_change_session" s2
    WHERE s2."project_id" = p."project_id" AND s2."last_job_id" = p."source_job_id"
  ) = 1;

-- 3) Every plan still unlinked gets ONE session of its own. Its origin is what
--    the row can PROVE: an MCP-authored plan ⇒ `mcp`, a cadence plan ⇒
--    `cadence`, anything else ⇒ `legacy` — core stores no job kind, so a
--    generation, an expand and an earlier or revised conversation submit cannot
--    be told apart, and AMENDMENT 17 §4 forbids guessing. The id is derived
--    from the plan's, so a re-run finds the row it already wrote.
INSERT INTO "plan_change_session" (
  "id", "workspace_id", "project_id", "created_by_id", "turn_count", "scope_key",
  "target_keys", "origin", "last_activity_at", "created_at", "updated_at"
)
SELECT
  'pcs_backfill_' || p."id",
  p."workspace_id",
  p."project_id",
  p."created_by_id",
  0,
  '',
  '{}',
  (CASE
    WHEN p."author_source" = 'mcp' THEN 'mcp'
    WHEN p."origin" = 'cadence' THEN 'cadence'
    ELSE 'legacy'
  END)::"plan_session_origin",
  COALESCE(p."decided_at", p."created_at"),
  p."created_at",
  CURRENT_TIMESTAMP
FROM "plan" p
WHERE p."session_id" IS NULL
ON CONFLICT ("id") DO NOTHING;

UPDATE "plan" p
SET "session_id" = 'pcs_backfill_' || p."id"
WHERE p."session_id" IS NULL;
