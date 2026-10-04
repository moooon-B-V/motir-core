-- Per-organization KILL-SWITCHES (Story 10.3 · MOTIR-750).
--
-- One table of OVERRIDES: a row exists only for an org whose switch a platform
-- superadmin has flipped. Evaluation is "this org's row, else the registry
-- default" (`lib/featureFlags/registry.ts`), so absence IS the documented safe
-- default and every existing org reads every switch ON. ADDITIVE: no existing
-- row changes.
--
-- ── ROW-LEVEL SECURITY ─────────────────────────────────────────────────────
-- No TENANT arm, by design: a customer never reads or writes its own switches.
--   · `app.platform_staff` — the console reads and writes them, inside
--     `withPlatformRead`, which also appends the audited `org.kill_switch_*` row.
--   · `app.system_admin` — the hot-path evaluation reads them under
--     `withSystemContext` (the enforcement points are partly actorless: an auto
--     re-run, a review run, a scheduled planning cadence). READ only: it is not on
--     `WITH CHECK`, so no system path can flip a switch.
-- ONE `FOR ALL` policy, because Postgres applies the UPDATE policy's `USING` to
-- `SELECT … FOR UPDATE` and an upsert's conflict arm (MOTIR-3707 / MOTIR-3710).
-- CreateTable
CREATE TABLE "org_feature_flag" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "reason" TEXT,
    "updated_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_feature_flag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "org_feature_flag_updated_by_user_id_idx" ON "org_feature_flag"("updated_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "org_feature_flag_organization_id_key_key" ON "org_feature_flag"("organization_id", "key");

-- AddForeignKey
ALTER TABLE "org_feature_flag" ADD CONSTRAINT "org_feature_flag_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_feature_flag" ADD CONSTRAINT "org_feature_flag_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ===========================================================================
-- Row-level security — org_feature_flag
-- ===========================================================================
ALTER TABLE "org_feature_flag" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "org_feature_flag" FORCE ROW LEVEL SECURITY;

CREATE POLICY "org_feature_flag_platform_or_system" ON "org_feature_flag"
  FOR ALL
  USING (
    coalesce(current_setting('app.platform_staff', true), '') = 'true'
    OR current_setting('app.system_admin', true) = 'true'
  )
  WITH CHECK (
    coalesce(current_setting('app.platform_staff', true), '') = 'true'
  );
