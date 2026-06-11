-- CreateEnum
CREATE TYPE "dashboard_access" AS ENUM ('private', 'workspace');

-- CreateEnum
CREATE TYPE "dashboard_layout" AS ENUM ('one', 'two', 'three');

-- CreateEnum
CREATE TYPE "dashboard_widget_type" AS ENUM ('filter_results', 'distribution', 'created_vs_resolved');

-- CreateTable
CREATE TABLE "dashboard" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "access" "dashboard_access" NOT NULL DEFAULT 'private',
    "layout" "dashboard_layout" NOT NULL DEFAULT 'two',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dashboard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_widget" (
    "id" TEXT NOT NULL,
    "dashboard_id" TEXT NOT NULL,
    "type" "dashboard_widget_type" NOT NULL,
    "column" INTEGER NOT NULL,
    "position" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "saved_filter_id" TEXT,
    "project_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dashboard_widget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dashboard_workspace_id_idx" ON "dashboard"("workspace_id");

-- CreateIndex
CREATE INDEX "dashboard_widget_dashboard_id_column_position_idx" ON "dashboard_widget"("dashboard_id", "column", "position");

-- CreateIndex
CREATE INDEX "dashboard_widget_saved_filter_id_idx" ON "dashboard_widget"("saved_filter_id");

-- CreateIndex
CREATE INDEX "dashboard_widget_project_id_idx" ON "dashboard_widget"("project_id");

-- AddForeignKey
ALTER TABLE "dashboard" ADD CONSTRAINT "dashboard_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashboard" ADD CONSTRAINT "dashboard_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashboard_widget" ADD CONSTRAINT "dashboard_widget_dashboard_id_fkey" FOREIGN KEY ("dashboard_id") REFERENCES "dashboard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashboard_widget" ADD CONSTRAINT "dashboard_widget_saved_filter_id_fkey" FOREIGN KEY ("saved_filter_id") REFERENCES "saved_filter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashboard_widget" ADD CONSTRAINT "dashboard_widget_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security (Story 6.3 · Subtask 6.3.1 — mirroring
-- add_saved_filters):
--   * `dashboard` — pure workspace gate (NON-NULL workspace_id, always
--     written inside an active workspace context): one PERMISSIVE FOR ALL
--     policy, USING + WITH CHECK against current_setting('app.workspace_id',
--     true) (missing_ok → unset GUC yields NULL → row hidden — safe failure).
--     ENABLE + FORCE so the table-owner role is subject too. The
--     private-vs-workspace ACCESS rule is the SERVICE's permission gate, not
--     RLS — RLS draws the tenant boundary only.
--   * `dashboard_widget` — NO workspace_id by design (denormalized tenancy
--     on a child row could lie), so the policy joins through the parent
--     dashboard and tests THAT row's workspace_id (the saved_filter_star
--     pattern). WITH CHECK closes the "attach a widget to another
--     workspace's dashboard" hole.
-- Grants: the workspace RLS migration's ALTER DEFAULT PRIVILEGES auto-grants
-- on every NEW table created by the owner role (same as saved_filter).
-- ===========================================================================
ALTER TABLE "dashboard" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dashboard" FORCE ROW LEVEL SECURITY;

CREATE POLICY "dashboard_active_workspace" ON "dashboard"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

ALTER TABLE "dashboard_widget" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dashboard_widget" FORCE ROW LEVEL SECURITY;

CREATE POLICY "dashboard_widget_active_workspace" ON "dashboard_widget"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "dashboard" d
      WHERE d."id" = "dashboard_widget"."dashboard_id"
        AND d."workspace_id" = current_setting('app.workspace_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "dashboard" d
      WHERE d."id" = "dashboard_widget"."dashboard_id"
        AND d."workspace_id" = current_setting('app.workspace_id', true)
    )
  );
