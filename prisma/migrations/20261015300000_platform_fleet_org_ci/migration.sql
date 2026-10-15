-- The platform FLEET ORG CI setting (Story MOTIR-8699 · MOTIR-8714): "Run
-- Motir's private repositories' CI on the fleet", one row per (project,
-- connected org). The row is the operator's INTENT; its effect is the org's
-- `MOTIR_RUNNER` Actions variable, written by `fleetOrgCiSettingService` inside
-- the same audited platform transaction. No row = OFF. ADDITIVE: a new table,
-- nothing existing changes, nothing is seeded.
--
-- ── ROW-LEVEL SECURITY ─────────────────────────────────────────────────────
-- `platform_run_model`'s shape (20261004120000), copied rather than invented:
--   · READ is unconditional. A row holds a project id, an org login, a flag and
--     the operator's stated reason — platform configuration with nothing a
--     tenant could learn from it — and the console's state read is not a
--     platform transaction.
--   · WRITE is `app.platform_staff` only: every write runs inside
--     `withPlatformWrite`, which appends the audit row in the same transaction.
-- ONE `FOR ALL` write arm, so UPDATE/DELETE have a permissive policy
-- (`tests/tenant-root-creation-rls.test.ts`). Grants: the add_workspace_rls
-- migration's ALTER DEFAULT PRIVILEGES covers every new table.
-- CreateTable
CREATE TABLE "platform_fleet_org_ci" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "org" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "last_reason" TEXT,
    "updated_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_fleet_org_ci_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_fleet_org_ci_updated_by_user_id_idx" ON "platform_fleet_org_ci"("updated_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_fleet_org_ci_project_id_org_key" ON "platform_fleet_org_ci"("project_id", "org");

-- AddForeignKey
ALTER TABLE "platform_fleet_org_ci" ADD CONSTRAINT "platform_fleet_org_ci_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_fleet_org_ci" ADD CONSTRAINT "platform_fleet_org_ci_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ===========================================================================
-- Row-level security — platform_fleet_org_ci
-- ===========================================================================
ALTER TABLE "platform_fleet_org_ci" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_fleet_org_ci" FORCE ROW LEVEL SECURITY;

CREATE POLICY "platform_fleet_org_ci_read" ON "platform_fleet_org_ci"
  FOR SELECT
  USING (true);

CREATE POLICY "platform_fleet_org_ci_platform_staff" ON "platform_fleet_org_ci"
  FOR ALL
  USING (coalesce(current_setting('app.platform_staff', true), '') = 'true')
  WITH CHECK (coalesce(current_setting('app.platform_staff', true), '') = 'true');
