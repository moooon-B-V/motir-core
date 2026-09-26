-- Workspace role storage — the EXPAND step (Story MOTIR-6168 · Subtask MOTIR-6457).
--
-- Roles move from the project to the WORKSPACE (`docs/decisions/role-model.md`
-- §2): each person holds ONE workspace role — Manager · Member · Viewer — or a
-- workspace custom role. This migration only makes room for that model, BESIDE
-- the legacy columns, in an expand → migrate → contract sequence:
--
--   1. `workspace_role` / `role_migration_reason` enums;
--   2. `workspace_membership.workspace_role` + `role_definition_id` (NULLABLE, no
--      default) with a RESTRICT foreign key to the custom-role table;
--   3. `workspace_role_definition` — a workspace's own custom roles;
--   4. `role_migration_report` — one row per person the move changed, and why;
--   5. ENABLE + FORCE row-level security on both new tables, with the pure
--      workspace-tenancy policy every workspace-bearing table takes.
--
-- NOTHING IS BACKFILLED AND NOTHING READS THE NEW COLUMNS YET. The mapping
-- (MOTIR-6458) fills them; the resolver (MOTIR-6459) reads them. So the release
-- this ships in changes no behaviour, and old and new code can both run against
-- this schema. `workspace_role` deliberately has NO default: a default would
-- silently give `member` to a row the still-serving old build creates as
-- `owner` during the deploy window. NULL is read as "derive from the legacy
-- `role`" (`resolveWorkspaceRole`, MOTIR-6459), and the follow-up contract story
-- makes the column NOT NULL once no NULL remains.
--
-- Every foreign key below is a Prisma `@relation` with these exact actions (the
-- CLAUDE.md no-raw-SQL-FK rule), so the next `migrate dev` proposes no change.

-- CreateEnum
CREATE TYPE "workspace_role" AS ENUM ('manager', 'member', 'viewer');

-- CreateEnum
CREATE TYPE "role_migration_reason" AS ENUM ('narrowest_kept', 'project_role_dropped', 'custom_role_recreated', 'custom_role_merged', 'mapped_narrower', 'org_admin_granted');

-- AlterTable
ALTER TABLE "workspace_membership" ADD COLUMN     "role_definition_id" TEXT,
ADD COLUMN     "workspace_role" "workspace_role";

-- CreateTable
CREATE TABLE "workspace_role_definition" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "permissions" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_role_definition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_migration_report" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "before_json" JSONB NOT NULL,
    "after_role" "workspace_role" NOT NULL,
    "after_role_definition_id" TEXT,
    "reason" "role_migration_reason" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dismissed_at" TIMESTAMP(3),

    CONSTRAINT "role_migration_report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workspace_role_definition_workspace_id_idx" ON "workspace_role_definition"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_role_definition_workspace_id_name_key" ON "workspace_role_definition"("workspace_id", "name");

-- CreateIndex
CREATE INDEX "role_migration_report_workspace_id_idx" ON "role_migration_report"("workspace_id");

-- CreateIndex
CREATE INDEX "role_migration_report_user_id_idx" ON "role_migration_report"("user_id");

-- CreateIndex
CREATE INDEX "role_migration_report_after_role_definition_id_idx" ON "role_migration_report"("after_role_definition_id");

-- CreateIndex
CREATE INDEX "workspace_membership_role_definition_id_idx" ON "workspace_membership"("role_definition_id");

-- AddForeignKey
ALTER TABLE "workspace_membership" ADD CONSTRAINT "workspace_membership_role_definition_id_fkey" FOREIGN KEY ("role_definition_id") REFERENCES "workspace_role_definition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_role_definition" ADD CONSTRAINT "workspace_role_definition_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_migration_report" ADD CONSTRAINT "role_migration_report_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_migration_report" ADD CONSTRAINT "role_migration_report_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_migration_report" ADD CONSTRAINT "role_migration_report_after_role_definition_id_fkey" FOREIGN KEY ("after_role_definition_id") REFERENCES "workspace_role_definition"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ===========================================================================
-- Row-level security — workspace_role_definition, role_migration_report
-- ===========================================================================
-- The same PURE workspace gate `project_role_definition` uses
-- (20260809000000_add_project_role_definition), copied rather than re-derived:
-- each table carries its own `workspace_id`, so the policy is one index-backed
-- comparison, not a join.
--   * ENABLE + FORCE so even the table-owner role is subject to it (FORCE does
--     not defeat BYPASSRLS on a superuser; production connects as the
--     non-bypass `motir_app`, and the RLS tests drop to it).
--   * `current_setting('app.workspace_id', true)` — missing_ok, so an unset GUC
--     yields NULL → predicate NULL → row hidden (the safe failure mode).
--   * ONE `FOR ALL` policy each; `WITH CHECK` refuses writing a row into a
--     foreign workspace. A role, and a record of whose role changed, describe the
--     shape of somebody's organisation — neither may leak across tenants.
--   * Grants: the add_workspace_rls migration's ALTER DEFAULT PRIVILEGES covers
--     every new table, so no explicit GRANT is needed.
--   * The GUC is compared directly, never through a subquery over another
--     RLS-enabled table, so the per-row cost stays one comparison.
ALTER TABLE "workspace_role_definition" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_role_definition" FORCE ROW LEVEL SECURITY;

CREATE POLICY "workspace_role_definition_active_workspace" ON "workspace_role_definition"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

ALTER TABLE "role_migration_report" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "role_migration_report" FORCE ROW LEVEL SECURITY;

CREATE POLICY "role_migration_report_active_workspace" ON "role_migration_report"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
