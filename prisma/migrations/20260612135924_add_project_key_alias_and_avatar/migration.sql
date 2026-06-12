-- Edit project details + change project key (Story 6.8 · Subtask 6.8.1).
-- Ships, in one atomic migration (migration-by-concern, PRODECT_FINDINGS #20 —
-- the table and its RLS policy land together so there is never an unguarded
-- window):
--   1. `project.avatarIcon` + `project.avatarColor` (nullable — NULL = the
--      shipped mono-identifier rendering, so existing rows backfill with no
--      data step);
--   2. the `project_key_alias` table (retired keys), its indexes + FKs (both
--      cascade — deleting the project/workspace frees the keys);
--   3. ENABLE + FORCE row-level security on `project_key_alias` + the tenancy
--      policy (the same pure workspace gate `project` / `project_membership` /
--      `work_item` use).
-- The alias-aware resolution everywhere a key is addressed (6.8.2) and the UI
-- (6.8.4) are OUT of scope here — this migration is the data model only.

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "avatarColor" TEXT,
ADD COLUMN     "avatarIcon" TEXT;

-- CreateTable
CREATE TABLE "project_key_alias" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_key_alias_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_key_alias_project_id_idx" ON "project_key_alias"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_key_alias_workspace_id_identifier_key" ON "project_key_alias"("workspace_id", "identifier");

-- AddForeignKey
ALTER TABLE "project_key_alias" ADD CONSTRAINT "project_key_alias_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_key_alias" ADD CONSTRAINT "project_key_alias_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security — project_key_alias
-- ===========================================================================
-- The same PURE workspace gate `project` / `project_membership` / `work_item`
-- use. An alias row is visible/mutable only when its denormalized
-- `workspace_id` matches the active-workspace GUC. Every alias read/write
-- happens INSIDE an active workspace context (a key is resolved within the
-- actor's workspace, a rename runs under the project's workspace), so the
-- single FOR ALL policy covers SELECT/INSERT/UPDATE/DELETE; WITH CHECK blocks
-- inserting/moving a row into a foreign workspace.
--   * ENABLE + FORCE so even the table-owner role (`prodect`) is subject to it.
--     FORCE does NOT defeat BYPASSRLS on the superuser — production connects as
--     the non-bypass `prodect_app` role (PRODECT_FINDINGS #5), and the RLS
--     tests drop to it.
--   * `current_setting('app.workspace_id', true)` — `true` is missing_ok, so an
--     unset GUC yields NULL → predicate NULL → row hidden (safe failure mode).
--   * Grants: the add_workspace_rls migration's ALTER DEFAULT PRIVILEGES grants
--     SELECT/INSERT/UPDATE/DELETE on every NEW table the `prodect` role creates,
--     so no explicit GRANT is needed here (same as project_membership).
ALTER TABLE "project_key_alias" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_key_alias" FORCE ROW LEVEL SECURITY;

CREATE POLICY "project_key_alias_active_workspace" ON "project_key_alias"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
