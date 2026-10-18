-- PROJECT AUTO-TRANSLATE SWITCH — the column and its trail (Story MOTIR-7738 · MOTIR-8825).
--
-- Two halves, nothing reading either yet: whether a project auto-translates its
-- WORK CONTENT, and an attributed history of every flip ("who / from / to /
-- when"), the project-tier twin of `organization_content_language_change`.
--
-- WHAT THIS MIGRATION DOES
--   1. `project.auto_translate_work_content` — one boolean, off for every
--      existing and every new project.
--   2. `project_auto_translate_change` — the trail, its indexes and its FKs
--      (every one a Prisma `@relation`, both sides, same actions).
--   3. RLS — the `page_version` pair: workspace-keyed, with a project-narrowing
--      SELECT arm.
--
-- One deploy, no expand/contract: both halves are additive and nothing reads
-- them before the service that ships later in the same story.

-- 1. The switch ----------------------------------------------------------------
--
-- `NOT NULL DEFAULT false` IS the whole data step. Today's behaviour is "content
-- shows as stored", so a project that predates the column is correctly false and
-- there is nothing to copy forward — unlike `acceptance_video_enabled`, whose
-- DEFAULT true would have switched a deliberately-off setting back on. A second
-- statement would only be a second thing a deploy could skip.
ALTER TABLE "project" ADD COLUMN "auto_translate_work_content" BOOLEAN NOT NULL DEFAULT false;

-- 2. The trail -------------------------------------------------------------------
--
-- `changed_by_user_id` is nullable: the actor FK is SET NULL, so erasing a
-- person keeps the record that the setting changed and drops only the
-- attribution. There is deliberately no CHECK forbidding from = to: whether a
-- no-op flip writes a row is the service's call.
CREATE TABLE "project_auto_translate_change" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "changed_by_user_id" TEXT,
    "from_enabled" BOOLEAN NOT NULL,
    "to_enabled" BOOLEAN NOT NULL,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_auto_translate_change_pkey" PRIMARY KEY ("id")
);

-- As every tenant table carries.
CREATE INDEX "project_auto_translate_change_workspace_id_idx" ON "project_auto_translate_change"("workspace_id");

-- The history read, newest first (a backward scan of the btree).
CREATE INDEX "project_auto_translate_change_project_id_changed_at_idx" ON "project_auto_translate_change"("project_id", "changed_at");

-- ON DELETE, one FK at a time:
--   * workspace_id / project_id  CASCADE — projects are soft-archived and never
--     hard-deleted, so the cascade fires only on a real delete (the
--     `page_version` reasoning).
--   * changed_by_user_id  SET NULL — the record outlives the account.
ALTER TABLE "project_auto_translate_change" ADD CONSTRAINT "project_auto_translate_change_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_auto_translate_change" ADD CONSTRAINT "project_auto_translate_change_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_auto_translate_change" ADD CONSTRAINT "project_auto_translate_change_changed_by_user_id_fkey" FOREIGN KEY ("changed_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 3. RLS on project_auto_translate_change ------------------------------------------
--
-- The `page_version` pair, clause for clause: PERMISSIVE FOR ALL on the row's own
-- `workspace_id` (USING + WITH CHECK), and RESTRICTIVE FOR SELECT narrowing to
-- `app.project_id` when it is set. Workspace-scoped, not organization-scoped: the
-- flip this table records happens inside a workspace-bound transaction. The
-- workspace RLS migration's `ALTER DEFAULT PRIVILEGES` grants the app role on
-- every new table.
ALTER TABLE "project_auto_translate_change" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_auto_translate_change" FORCE ROW LEVEL SECURITY;

CREATE POLICY "project_auto_translate_change_active_workspace" ON "project_auto_translate_change"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

CREATE POLICY "project_auto_translate_change_project_narrow" ON "project_auto_translate_change"
  AS RESTRICTIVE
  FOR SELECT
  USING (
    coalesce(current_setting('app.project_id', true), '') = ''
    OR "project_id" = current_setting('app.project_id', true)
  );
