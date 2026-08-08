-- Custom project roles — the persistence layer (Story MOTIR-2257 · Subtask
-- MOTIR-2467). Migration-by-concern (PRODECT_FINDINGS #20): the table and its
-- RLS policy land together, so there is never an unguarded window.
--
--   1. `project_role_definition` — one row per custom role, its indexes + FKs;
--   2. ENABLE + FORCE row-level security + the workspace tenancy policy;
--   3. `project_membership.role_definition_id` — a NULLABLE pointer with an
--      `ON DELETE RESTRICT` FK, plus its index.
--
-- NOTHING READS THE NEW COLUMN YET. The resolution arm (MOTIR-2470) is what
-- makes a custom role mean anything; the service (MOTIR-2472) is what writes
-- one. This migration changes no behaviour at all, which is what makes it safe
-- to ship first and verify in isolation.
--
-- NO DATA STEP, DELIBERATELY. Every existing `project_membership` row keeps its
-- `role` untouched and backfills `role_definition_id` to NULL — which is
-- defined to mean exactly what a membership meant before this column existed
-- ("names a BUILT-IN role through `role`"). A permissions migration that
-- alters existing rows has to be right the first time on real customer data;
-- this one has nothing to be wrong about.

-- CreateTable
CREATE TABLE "project_role_definition" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "based_on" "member_role" NOT NULL,
    "permissions" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_role_definition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_role_definition_workspace_id_idx" ON "project_role_definition"("workspace_id");

-- CreateIndex
CREATE INDEX "project_role_definition_project_id_idx" ON "project_role_definition"("project_id");

-- CreateIndex
-- A role's name is unique WITHIN a project; the same name in a different
-- project is fine (a project's roles are its own — there is no cross-project
-- scheme). The service translates the resulting P2002 into a typed
-- RoleNameTakenError so a raw database error never escapes.
CREATE UNIQUE INDEX "project_role_definition_project_id_name_key" ON "project_role_definition"("project_id", "name");

-- AddForeignKey
ALTER TABLE "project_role_definition" ADD CONSTRAINT "project_role_definition_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_role_definition" ADD CONSTRAINT "project_role_definition_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security — project_role_definition
-- ===========================================================================
-- The same PURE workspace gate `project_membership` / `project` / `work_item` /
-- `workflow_status` use (add_project_membership_and_roles), copied rather than
-- re-derived. NOT an RLS join through `project`: the table carries its own
-- denormalized `workspace_id`, so the policy is one index-backed comparison and
-- cannot be defeated by a project row the reader can already see.
--
-- A role is a description of who may do what, so leaking one across tenants
-- would leak the shape of somebody's organisation.
--   * ENABLE + FORCE so even the table-owner role (`prodect`) is subject to it.
--     FORCE does NOT defeat BYPASSRLS on the superuser — production connects as
--     the non-bypass `prodect_app` role (PRODECT_FINDINGS #5), and the RLS tests
--     drop to it.
--   * `current_setting('app.workspace_id', true)` — `true` is missing_ok, so an
--     unset GUC yields NULL → predicate NULL → row hidden (safe failure mode).
--   * ONE `FOR ALL` policy covers SELECT/INSERT/UPDATE/DELETE; `WITH CHECK`
--     blocks inserting or moving a row into a foreign workspace. Every read and
--     write of a role definition happens INSIDE an active workspace context, so
--     the `OR user_id = app.user_id` escape `workspace_membership` carries (for
--     the pre-context switcher bootstrap) is deliberately NOT replicated.
--   * Grants: the add_workspace_rls migration's ALTER DEFAULT PRIVILEGES grants
--     SELECT/INSERT/UPDATE/DELETE on every NEW table the `prodect` role creates,
--     so no explicit GRANT is needed here.
ALTER TABLE "project_role_definition" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_role_definition" FORCE ROW LEVEL SECURITY;

CREATE POLICY "project_role_definition_active_workspace" ON "project_role_definition"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

-- ===========================================================================
-- project_membership.role_definition_id — the nullable pointer
-- ===========================================================================
-- ⚠️ ON DELETE RESTRICT, and it is the load-bearing choice in this migration.
-- There are three ways a database can react when someone deletes a role three
-- people are holding, and two of them are quietly catastrophic:
--   * CASCADE  — deletes the MEMBERSHIP; those three lose the project entirely.
--   * SET NULL — silently drops them back to whatever their `role` column says,
--                which may be more access than they had, or less.
-- Both look like success from the admin's side. RESTRICT makes the DATABASE
-- refuse, so the only route to deleting a role is the service's
-- reassign-then-delete path (MOTIR-2472) — the guarantee is enforced by the
-- storage rather than remembered by the code above it.
--
-- The FK is modelled as a Prisma `@relation` on BOTH sides
-- (ProjectMembership.roleDefinition ↔ ProjectRoleDefinition.memberships) with
-- these exact actions, per the CLAUDE.md no-raw-SQL-FK rule — so the next
-- `migrate dev` reports no difference rather than re-proposing a DROP.
ALTER TABLE "project_membership" ADD COLUMN "role_definition_id" TEXT;

-- CreateIndex
CREATE INDEX "project_membership_role_definition_id_idx" ON "project_membership"("role_definition_id");

-- AddForeignKey
ALTER TABLE "project_membership" ADD CONSTRAINT "project_membership_role_definition_id_fkey" FOREIGN KEY ("role_definition_id") REFERENCES "project_role_definition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
