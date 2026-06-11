-- CreateEnum
CREATE TYPE "automation_trigger_type" AS ENUM ('created', 'transitioned', 'field_changed', 'commented');

-- CreateEnum
CREATE TYPE "automation_execution_status" AS ENUM ('success', 'failure', 'no_actions');

-- CreateTable
CREATE TABLE "automation_rule" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "trigger_type" "automation_trigger_type" NOT NULL,
    "trigger_config" JSONB NOT NULL,
    "condition_ast" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "consecutive_failure_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_rule_execution" (
    "id" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "status" "automation_execution_status" NOT NULL,
    "work_item_id" TEXT,
    "error" TEXT,
    "duration_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_rule_execution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "automation_rule_project_id_trigger_type_enabled_idx" ON "automation_rule"("project_id", "trigger_type", "enabled");

-- CreateIndex
CREATE INDEX "automation_rule_workspace_id_idx" ON "automation_rule"("workspace_id");

-- CreateIndex
CREATE INDEX "automation_rule_execution_rule_id_created_at_idx" ON "automation_rule_execution"("rule_id", "created_at");

-- AddForeignKey
ALTER TABLE "automation_rule" ADD CONSTRAINT "automation_rule_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_rule" ADD CONSTRAINT "automation_rule_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_rule" ADD CONSTRAINT "automation_rule_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_rule_execution" ADD CONSTRAINT "automation_rule_execution_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "automation_rule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_rule_execution" ADD CONSTRAINT "automation_rule_execution_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security (Story 6.6 · Subtask 6.6.1 — mirroring add_saved_filters):
--   * `automation_rule` — pure workspace gate (NON-NULL workspace_id, always
--     written inside an active workspace context): one PERMISSIVE FOR ALL
--     policy, USING + WITH CHECK against current_setting('app.workspace_id',
--     true) (missing_ok → unset GUC yields NULL → row hidden — safe failure).
--     ENABLE + FORCE so the table-owner role is subject too. The
--     project-admin gating is the SERVICE's permission check, not RLS — RLS
--     draws the tenant boundary only.
--   * `automation_rule_execution` — NO workspace_id by design (denormalized
--     tenancy on a child row could lie — the saved_filter_star pattern), so the
--     policy joins through the parent automation_rule and tests THAT row's
--     workspace_id. WITH CHECK closes the "write an execution row against
--     another workspace's rule" hole.
-- Grants: the workspace RLS migration's ALTER DEFAULT PRIVILEGES auto-grants
-- on every NEW table created by the owner role (same as saved_filter).
-- ===========================================================================
ALTER TABLE "automation_rule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "automation_rule" FORCE ROW LEVEL SECURITY;

CREATE POLICY "automation_rule_active_workspace" ON "automation_rule"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

ALTER TABLE "automation_rule_execution" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "automation_rule_execution" FORCE ROW LEVEL SECURITY;

CREATE POLICY "automation_rule_execution_active_workspace" ON "automation_rule_execution"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "automation_rule" ar
      WHERE ar."id" = "automation_rule_execution"."rule_id"
        AND ar."workspace_id" = current_setting('app.workspace_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "automation_rule" ar
      WHERE ar."id" = "automation_rule_execution"."rule_id"
        AND ar."workspace_id" = current_setting('app.workspace_id', true)
    )
  );
