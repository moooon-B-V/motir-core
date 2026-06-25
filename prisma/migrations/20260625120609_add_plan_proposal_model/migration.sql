-- The AI-planning Plan substrate (Story 7.21 / MOTIR-1336): a `Plan` bundles
-- proposed `PlanItem` operations (add / modify / remove) the user reviews and
-- approves/declines as a unit. A PlanItem is a PROPOSAL, never a row in the
-- work-item tree — an `add` lives only as a PlanItem (no work_item until
-- approve), and `modify`/`remove` leave their targets untouched until approve.
-- On approve the items MATERIALIZE; on decline they drop with the tree
-- untouched. Both tables are workspace-scoped tenant data, so they land WITH
-- their RLS policy in this same migration (migration-by-concern, PRODECT_FINDINGS
-- #20 — no unguarded window). All three classes of FK are modelled as Prisma
-- `@relation`s (forward + back-relation) with these same actions, so
-- `migrate dev` reports "No difference detected" (the FK-`@relation` rule,
-- bug-attachment-fk-migration-drift): workspace/project/plan CASCADE (tenant +
-- bundle teardown), decided_by / work_item SET NULL (a deleted decider or an
-- archived/deleted target never destroys plan history). `plan_item`'s
-- `@@unique(plan_id, work_item_id)` makes a modify/remove target unique per plan
-- (Postgres NULLs are distinct, so multiple `add` rows — null target — are fine).

-- CreateEnum
CREATE TYPE "plan_status" AS ENUM ('generating', 'planned', 'approved', 'declined');

-- CreateEnum
CREATE TYPE "plan_item_op" AS ENUM ('add', 'modify', 'remove');

-- CreateTable
CREATE TABLE "plan" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "status" "plan_status" NOT NULL DEFAULT 'generating',
    "title" TEXT,
    "summary" TEXT,
    "source_job_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "planned_at" TIMESTAMP(3),
    "decided_at" TIMESTAMP(3),
    "decided_by_id" TEXT,

    CONSTRAINT "plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_item" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "op" "plan_item_op" NOT NULL,
    "work_item_id" TEXT,
    "proposed_fields" JSONB,
    "patch" JSONB,
    "parent_ref" TEXT,
    "blocked_by_refs" TEXT[],
    "base_revision" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "plan_workspace_id_idx" ON "plan"("workspace_id");

-- CreateIndex
CREATE INDEX "plan_project_id_created_at_idx" ON "plan"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "plan_item_plan_id_idx" ON "plan_item"("plan_id");

-- CreateIndex
CREATE INDEX "plan_item_workspace_id_idx" ON "plan_item"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "plan_item_plan_id_work_item_id_key" ON "plan_item"("plan_id", "work_item_id");

-- AddForeignKey
ALTER TABLE "plan" ADD CONSTRAINT "plan_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan" ADD CONSTRAINT "plan_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan" ADD CONSTRAINT "plan_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_item" ADD CONSTRAINT "plan_item_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_item" ADD CONSTRAINT "plan_item_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_item" ADD CONSTRAINT "plan_item_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security — plan (pure workspace gate, no escape hatch)
-- ===========================================================================
-- The SAME single PERMISSIVE FOR ALL policy as sprint / comment /
-- sprint_report_entry: USING + WITH CHECK against
-- current_setting('app.workspace_id', true) (`true` = missing_ok, so an unset
-- GUC yields NULL → predicate NULL → row hidden, the safe failure). ENABLE +
-- FORCE so even the table-owner `prodect` role is subject to it (production +
-- the service writes connect as the non-BYPASSRLS `prodect_app` role). The
-- workspace RLS migration's `ALTER DEFAULT PRIVILEGES … TO prodect_app`
-- auto-grants on every NEW table created by the `prodect` role, so no explicit
-- GRANT is needed (same as sprint / comment / sprint_report_entry).
ALTER TABLE "plan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plan" FORCE ROW LEVEL SECURITY;

CREATE POLICY "plan_active_workspace" ON "plan"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

-- ===========================================================================
-- Row-level security — plan_item (pure workspace gate, no escape hatch)
-- ===========================================================================
ALTER TABLE "plan_item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plan_item" FORCE ROW LEVEL SECURITY;

CREATE POLICY "plan_item_active_workspace" ON "plan_item"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
