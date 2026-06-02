-- Per-project customizable status workflows (Story 2.2 · Subtask 2.2.1). This
-- migration ships, in one atomic step (migration-by-concern, PRODECT_FINDINGS
-- #20 — table + its policy land together so there is never an unguarded
-- window):
--   1. two enums — `status_category` (the Jira three-bucket taxonomy) and
--      `workflow_policy_mode` (restricted / open);
--   2. the `project.workflowPolicyMode` column (default `restricted`);
--   3. the `workflow_status` + `workflow_transition` tables, their indexes
--      and FKs;
--   4. a PARTIAL unique index enforcing exactly-one-initial-status-per-project
--      (Prisma's schema DSL can't express a partial index, so it's raw SQL
--      here — the schema model carries a comment pointing at this file);
--   5. ENABLE + FORCE row-level security on both tables + the tenancy policy.
--
-- ===========================================================================
-- Why a PURE workspace gate — NO system-admin escape hatch (deviates from the
-- 2.2.1 card, which asked to copy job_run's hatch via finding #33)
-- ===========================================================================
-- `workflow_status` / `workflow_transition` are pure tenant data: every row
-- carries a NON-NULL `workspace_id`, and every write happens INSIDE an active
-- workspace context (2.2.2's seed runs in createProject's
-- withWorkspaceContext transaction, where `app.workspace_id` is already
-- bound). That makes them exactly like `project` (20260529202445_add_project_
-- rls) and `work_item` (20260601074342_add_work_item_rls) — both of which
-- ship a PURE workspace gate with no hatch — and UNLIKE `job_run` /
-- `job_run_dlq`, which carry the `app.system_admin` hatch ONLY because their
-- writer is the background runtime (context-less, OUTSIDE any request) and
-- because they hold untenanted SYSTEM rows (`workspace_id IS NULL`). Neither
-- condition holds here: there is no context-less writer and no nullable
-- workspace. Bolting on the hatch would be a latent cross-tenant widening
-- (any future code path that set `app.system_admin` would see every project's
-- workflows). So the policy mirrors work_item / project, not job_run.
-- (Decision-authority ladder — rung 2 "shipped code" over rung 3 "the card";
-- the card's prose said "mirrors work_item's" then inconsistently appended
-- job_run's hatch. Recorded as PRODECT_FINDINGS for 2.2.)
--
-- Policy shape (same as add_project_rls / add_work_item_rls's workspace gate):
--   * ENABLE + FORCE so even the table-owner role (`prodect`) is subject to
--     the policy. FORCE does NOT defeat BYPASSRLS on the superuser — that's
--     why production connects as the non-bypass `prodect_app` role
--     (PRODECT_FINDINGS #5), and why the RLS tests drop to it.
--   * `current_setting('app.workspace_id', true)` — the `true` is missing_ok,
--     so an unset GUC yields NULL → the predicate is NULL → row hidden. Safe
--     failure mode (no context → nothing visible).
--   * FOR ALL on a single permissive policy per table: every workflow write
--     happens inside an already-active workspace context, so the same
--     predicate covers SELECT/INSERT/UPDATE/DELETE via USING + WITH CHECK.
--     WITH CHECK blocks inserting/moving a row into a foreign workspace.
--
-- Grants: the workspace RLS migration's `ALTER DEFAULT PRIVILEGES IN SCHEMA
-- public ... TO prodect_app` auto-grants SELECT/INSERT/UPDATE/DELETE on every
-- NEW table created by the `prodect` role. Both tables here are created by
-- that role, so no explicit GRANT is needed (same as work_item / job_run).
--
-- NOT done here: seeding the default workflow rows. That is 2.2.2's job, done
-- in application code (workflowsService.seedDefaultWorkflow) under the request
-- context where `app.workspace_id` is bound — a SQL INSERT in this migration
-- could not set the GUC and would be rejected by the FORCE policy under the
-- prodect_app role. `work_item.status` keeps its String type (2.2.4 enforces
-- integrity at the service layer); this migration does not touch it.

-- CreateEnum
CREATE TYPE "status_category" AS ENUM ('todo', 'in_progress', 'done');

-- CreateEnum
CREATE TYPE "workflow_policy_mode" AS ENUM ('restricted', 'open');

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "workflowPolicyMode" "workflow_policy_mode" NOT NULL DEFAULT 'restricted';

-- CreateTable
CREATE TABLE "workflow_status" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "category" "status_category" NOT NULL,
    "color" TEXT,
    "position" TEXT NOT NULL,
    "is_initial" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_status_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_transition" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "from_status_id" TEXT NOT NULL,
    "to_status_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_transition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workflow_status_workspace_id_idx" ON "workflow_status"("workspace_id");

-- CreateIndex
CREATE INDEX "workflow_status_project_id_position_idx" ON "workflow_status"("project_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_status_project_id_key_key" ON "workflow_status"("project_id", "key");

-- CreateIndex
CREATE INDEX "workflow_transition_workspace_id_idx" ON "workflow_transition"("workspace_id");

-- CreateIndex
CREATE INDEX "workflow_transition_project_id_idx" ON "workflow_transition"("project_id");

-- CreateIndex
CREATE INDEX "workflow_transition_from_status_id_idx" ON "workflow_transition"("from_status_id");

-- CreateIndex
CREATE INDEX "workflow_transition_to_status_id_idx" ON "workflow_transition"("to_status_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_transition_project_id_from_status_id_to_status_id_key" ON "workflow_transition"("project_id", "from_status_id", "to_status_id");

-- AddForeignKey
ALTER TABLE "workflow_status" ADD CONSTRAINT "workflow_status_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_status" ADD CONSTRAINT "workflow_status_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_transition" ADD CONSTRAINT "workflow_transition_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_transition" ADD CONSTRAINT "workflow_transition_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_transition" ADD CONSTRAINT "workflow_transition_from_status_id_fkey" FOREIGN KEY ("from_status_id") REFERENCES "workflow_status"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_transition" ADD CONSTRAINT "workflow_transition_to_status_id_fkey" FOREIGN KEY ("to_status_id") REFERENCES "workflow_status"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Partial unique index — exactly one initial status per project
-- ===========================================================================
-- Prisma's schema DSL cannot express a partial (WHERE-filtered) unique index,
-- so it lives here as raw SQL. Only rows with `is_initial = true` participate
-- in the uniqueness, so a project may have many non-initial statuses but at
-- most one initial one. A second initial-status insert/update fails with a
-- unique_violation (SQLSTATE 23505).
CREATE UNIQUE INDEX "workflow_status_one_initial_per_project"
  ON "workflow_status"("project_id")
  WHERE "is_initial" = true;

-- ===========================================================================
-- Row-level security — workflow_status + workflow_transition
-- ===========================================================================
ALTER TABLE "workflow_status" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workflow_status" FORCE ROW LEVEL SECURITY;

ALTER TABLE "workflow_transition" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workflow_transition" FORCE ROW LEVEL SECURITY;

-- workflow_status: pure workspace gate. A status is visible/mutable only when
-- it belongs to the active workspace. USING governs SELECT/UPDATE/DELETE
-- visibility; WITH CHECK governs the post-image of INSERT/UPDATE so a write
-- can't place (or move) a row into a foreign workspace.
CREATE POLICY "workflow_status_active_workspace" ON "workflow_status"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

-- workflow_transition: identical gate. The denormalized `workspace_id` (kept
-- honest by the FK chain — both endpoints + the project share one workspace)
-- makes this a direct comparison, no join.
CREATE POLICY "workflow_transition_active_workspace" ON "workflow_transition"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
