-- A project's runner groups in CONNECTED orgs (Story MOTIR-8699 · MOTIR-8712).
--
-- The provisioning org's group stays on `project.runner_group_*`; this table holds
-- one row per OTHER org that owns some of the project's private repositories and
-- has the provisioning App installed. Purely additive: no backfill, no contract
-- step, and the release before this one never reads it.
--
-- The FK is modelled as a Prisma `@relation` on both sides with the same actions
-- (the FK-`@relation` rule), so `migrate dev` reports no difference.

-- CreateTable
CREATE TABLE "project_runner_group" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "org" TEXT NOT NULL,
    "installation_id" TEXT NOT NULL,
    "runner_group_id" INTEGER NOT NULL,
    "runner_group_name" TEXT NOT NULL,
    "synced_at" TIMESTAMP(3),
    "sync_pending" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_runner_group_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_runner_group_workspace_id_idx" ON "project_runner_group"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_runner_group_project_id_org_key" ON "project_runner_group"("project_id", "org");

-- AddForeignKey
ALTER TABLE "project_runner_group" ADD CONSTRAINT "project_runner_group_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security — project_runner_group (pure workspace gate, no escape)
-- ===========================================================================
-- The same single PERMISSIVE FOR ALL policy `project_repository` carries: every
-- read and write comes from `projectRunnerGroupService` under
-- `withWorkspaceServiceContext` bound to the project's own workspace, so no
-- system-admin escape is needed. ENABLE + FORCE so the table owner is subject to
-- it too; the default privileges grant `prodect_app` access to new tables.
ALTER TABLE "project_runner_group" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_runner_group" FORCE ROW LEVEL SECURITY;

CREATE POLICY "project_runner_group_active_workspace" ON "project_runner_group"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
