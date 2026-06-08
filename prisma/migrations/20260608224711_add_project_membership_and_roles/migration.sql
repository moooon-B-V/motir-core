-- Project-level access gating (Story 6.4 · Subtask 6.4.2). Ships, in one
-- atomic migration (migration-by-concern, PRODECT_FINDINGS #20 — the table and
-- its RLS policy land together so there is never an unguarded window):
--   1. two enums — `member_role` (the formalized workspace/project role set)
--      and `project_access_level` (Jira team-managed open/limited/private);
--   2. `project.accessLevel` (default `open` so existing projects backfill
--      with no lockout);
--   3. the in-place conversion of `workspace_membership.role` from a free
--      String into the `member_role` enum, migration-aware (owner→owner,
--      everything else→member);
--   4. the `project_membership` join table, its indexes + FKs;
--   5. ENABLE + FORCE row-level security on `project_membership` + the tenancy
--      policy (the same pure workspace gate `project` / `work_item` /
--      `workflow_status` use).
--
-- The enforcement policy (canBrowse/canEdit) + the management API + the UI are
-- OUT of scope here (6.4.3 / 6.4.4 / 6.4.5 / 6.4.6) — this migration is the
-- data model only.

-- CreateEnum
CREATE TYPE "member_role" AS ENUM ('owner', 'admin', 'member', 'viewer');

-- CreateEnum
CREATE TYPE "project_access_level" AS ENUM ('open', 'limited', 'private');

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "accessLevel" "project_access_level" NOT NULL DEFAULT 'open';

-- ===========================================================================
-- Convert workspace_membership.role (free String) → member_role enum, IN PLACE
-- ===========================================================================
-- Migration-aware (the card's mapping): existing values map owner→owner,
-- everything else→member, so no membership is dropped. (The original column was
-- a free String with a 'member' default + 'owner' for workspace founders; both
-- are preserved.) Prisma's auto-generated diff proposed DROP COLUMN + ADD COLUMN
-- — that would silently null every existing role — so this is hand-curated to an
-- in-place ALTER ... TYPE ... USING. The text default can't be cast to the enum
-- while attached, so drop it first, convert, then restore it as the enum value.
ALTER TABLE "workspace_membership" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "workspace_membership"
  ALTER COLUMN "role" TYPE "member_role"
  USING (CASE WHEN "role" = 'owner' THEN 'owner' ELSE 'member' END::"member_role");
ALTER TABLE "workspace_membership" ALTER COLUMN "role" SET DEFAULT 'member';

-- CreateTable
CREATE TABLE "project_membership" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "member_role" NOT NULL DEFAULT 'member',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_membership_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_membership_workspace_id_idx" ON "project_membership"("workspace_id");

-- CreateIndex
CREATE INDEX "project_membership_project_id_idx" ON "project_membership"("project_id");

-- CreateIndex
CREATE INDEX "project_membership_user_id_idx" ON "project_membership"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_membership_user_id_project_id_key" ON "project_membership"("user_id", "project_id");

-- AddForeignKey
ALTER TABLE "project_membership" ADD CONSTRAINT "project_membership_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_membership" ADD CONSTRAINT "project_membership_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_membership" ADD CONSTRAINT "project_membership_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security — project_membership
-- ===========================================================================
-- The same PURE workspace gate `project` / `work_item` / `workflow_status` use
-- (add_project_rls / add_work_item_rls / add_workflow_status_and_transition_rls).
-- A membership row is visible/mutable only when its denormalized `workspace_id`
-- matches the active-workspace GUC. The `OR userId = app.user_id` escape that
-- `workspace_membership` carries is deliberately NOT replicated: that disjunction
-- exists only for the switcher/bootstrap path that reads memberships BEFORE any
-- workspace context is set, whereas every project-membership read/write happens
-- INSIDE an active workspace context (you browse a project within your active
-- workspace). So the single FOR ALL policy covers SELECT/INSERT/UPDATE/DELETE;
-- WITH CHECK blocks inserting/moving a row into a foreign workspace.
--   * ENABLE + FORCE so even the table-owner role (`prodect`) is subject to it.
--     FORCE does NOT defeat BYPASSRLS on the superuser — production connects as
--     the non-bypass `prodect_app` role (PRODECT_FINDINGS #5), and the RLS tests
--     drop to it.
--   * `current_setting('app.workspace_id', true)` — `true` is missing_ok, so an
--     unset GUC yields NULL → predicate NULL → row hidden (safe failure mode).
--   * Grants: the add_workspace_rls migration's ALTER DEFAULT PRIVILEGES grants
--     SELECT/INSERT/UPDATE/DELETE on every NEW table the `prodect` role creates,
--     so no explicit GRANT is needed here (same as work_item / workflow_status).
ALTER TABLE "project_membership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_membership" FORCE ROW LEVEL SECURITY;

CREATE POLICY "project_membership_active_workspace" ON "project_membership"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
