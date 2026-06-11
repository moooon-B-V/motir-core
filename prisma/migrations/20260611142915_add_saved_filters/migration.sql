-- CreateEnum
CREATE TYPE "saved_filter_visibility" AS ENUM ('private', 'project');

-- CreateTable
CREATE TABLE "saved_filter" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_lower" TEXT NOT NULL,
    "description" TEXT,
    "visibility" "saved_filter_visibility" NOT NULL DEFAULT 'private',
    "ast_envelope" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_filter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_filter_star" (
    "id" TEXT NOT NULL,
    "saved_filter_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_filter_star_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "saved_filter_project_id_owner_id_idx" ON "saved_filter"("project_id", "owner_id");

-- CreateIndex
CREATE INDEX "saved_filter_workspace_id_idx" ON "saved_filter"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "saved_filter_project_id_name_lower_key" ON "saved_filter"("project_id", "name_lower");

-- CreateIndex
CREATE INDEX "saved_filter_star_user_id_idx" ON "saved_filter_star"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "saved_filter_star_saved_filter_id_user_id_key" ON "saved_filter_star"("saved_filter_id", "user_id");

-- AddForeignKey
ALTER TABLE "saved_filter" ADD CONSTRAINT "saved_filter_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_filter" ADD CONSTRAINT "saved_filter_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_filter" ADD CONSTRAINT "saved_filter_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_filter_star" ADD CONSTRAINT "saved_filter_star_saved_filter_id_fkey" FOREIGN KEY ("saved_filter_id") REFERENCES "saved_filter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_filter_star" ADD CONSTRAINT "saved_filter_star_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security (Story 6.2 · Subtask 6.2.1 — mirroring
-- add_labels_components_watchers):
--   * `saved_filter` — pure workspace gate (NON-NULL workspace_id, always
--     written inside an active workspace context): one PERMISSIVE FOR ALL
--     policy, USING + WITH CHECK against current_setting('app.workspace_id',
--     true) (missing_ok → unset GUC yields NULL → row hidden — safe failure).
--     ENABLE + FORCE so the table-owner role is subject too. The
--     private-vs-project VISIBILITY rule is the SERVICE's permission matrix,
--     not RLS — RLS draws the tenant boundary only.
--   * `saved_filter_star` — NO workspace_id by design (denormalized tenancy
--     on a child row could lie), so the policy joins through the parent
--     saved_filter and tests THAT row's workspace_id (the work_item_label
--     pattern). WITH CHECK closes the "star another workspace's filter" hole.
-- Grants: the workspace RLS migration's ALTER DEFAULT PRIVILEGES auto-grants
-- on every NEW table created by the owner role (same as label / watcher).
-- ===========================================================================
ALTER TABLE "saved_filter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "saved_filter" FORCE ROW LEVEL SECURITY;

CREATE POLICY "saved_filter_active_workspace" ON "saved_filter"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

ALTER TABLE "saved_filter_star" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "saved_filter_star" FORCE ROW LEVEL SECURITY;

CREATE POLICY "saved_filter_star_active_workspace" ON "saved_filter_star"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "saved_filter" sf
      WHERE sf."id" = "saved_filter_star"."saved_filter_id"
        AND sf."workspace_id" = current_setting('app.workspace_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "saved_filter" sf
      WHERE sf."id" = "saved_filter_star"."saved_filter_id"
        AND sf."workspace_id" = current_setting('app.workspace_id', true)
    )
  );
