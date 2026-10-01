-- MOTIR-6910 · docs/decisions/fleet-per-org-pool.md §3: CI is debited while it runs.
-- CreateTable
CREATE TABLE "ci_live_accrual" (
    "id" TEXT NOT NULL,
    "provisioning_intent_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "run_attempt" INTEGER NOT NULL,
    "tick_start" TIMESTAMP(3) NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "accrued_seconds" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ci_live_accrual_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ci_live_accrual_run_id_run_attempt_idx" ON "ci_live_accrual"("run_id", "run_attempt");

-- CreateIndex
CREATE INDEX "ci_live_accrual_organization_id_idx" ON "ci_live_accrual"("organization_id");

-- CreateIndex
CREATE INDEX "ci_live_accrual_workspace_id_idx" ON "ci_live_accrual"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "ci_live_accrual_provisioning_intent_id_tick_start_key" ON "ci_live_accrual"("provisioning_intent_id", "tick_start");

-- AddForeignKey
ALTER TABLE "ci_live_accrual" ADD CONSTRAINT "ci_live_accrual_provisioning_intent_id_fkey" FOREIGN KEY ("provisioning_intent_id") REFERENCES "ci_runner_provisioning_intent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ci_live_accrual" ADD CONSTRAINT "ci_live_accrual_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ci_live_accrual" ADD CONSTRAINT "ci_live_accrual_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- Row-level security — ci_live_accrual
-- ===========================================================================
-- Written and read only by background paths with no session: the live-charge
-- tick (`system.ci-live-charge`) and the `workflow_run` meter's reconciliation,
-- both under `withSystemContext`. No tenant surface reads it; the org's CI line
-- reads the `ci_period_usage` rollup these rows feed. So the policy is the
-- narrow one `fleet_in_flight_slot` uses: `app.system_admin` and nothing else.
-- A row a tenant could delete would reset the checkpoint and have its minutes
-- counted again.
ALTER TABLE "ci_live_accrual" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ci_live_accrual" FORCE ROW LEVEL SECURITY;

CREATE POLICY "ci_live_accrual_system_only" ON "ci_live_accrual"
  FOR ALL
  USING (current_setting('app.system_admin', true) = 'true')
  WITH CHECK (current_setting('app.system_admin', true) = 'true');
