-- CreateTable
CREATE TABLE "fleet_machine_kill" (
    "id" TEXT NOT NULL,
    "app" TEXT NOT NULL,
    "machine_id" TEXT NOT NULL,
    "machine_name" TEXT NOT NULL DEFAULT '',
    "reason" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "workload" TEXT,
    "record_ref" TEXT,
    "organization_id" TEXT,
    "machine_created_at" TIMESTAMP(3),
    "age_seconds" INTEGER NOT NULL,
    "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "failure_detail" TEXT,

    CONSTRAINT "fleet_machine_kill_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fleet_machine_kill_organization_id_decided_at_idx" ON "fleet_machine_kill"("organization_id", "decided_at");

-- CreateIndex
CREATE INDEX "fleet_machine_kill_decided_at_idx" ON "fleet_machine_kill"("decided_at");

-- AddForeignKey
ALTER TABLE "fleet_machine_kill" ADD CONSTRAINT "fleet_machine_kill_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ===========================================================================
-- Written only by the attribution reconciler (`system.fleet-attribution`) under
-- `withSystemContext`, and read by the platform admin's view (MOTIR-6905) the
-- same way. No tenant surface reads it: a kill row names a machine in Motir's
-- own fleet organisation, which is platform information. So the policy is the
-- narrow one `fleet_in_flight_slot` uses: `app.system_admin` and nothing else.
ALTER TABLE "fleet_machine_kill" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fleet_machine_kill" FORCE ROW LEVEL SECURITY;

CREATE POLICY "fleet_machine_kill_system_only" ON "fleet_machine_kill"
  FOR ALL
  USING (current_setting('app.system_admin', true) = 'true')
  WITH CHECK (current_setting('app.system_admin', true) = 'true');
