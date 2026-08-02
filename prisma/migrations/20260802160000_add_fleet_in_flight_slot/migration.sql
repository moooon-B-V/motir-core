-- CreateTable
CREATE TABLE "fleet_in_flight_slot" (
    "id" TEXT NOT NULL,
    "workload" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "organization_id" TEXT,
    "workspace_id" TEXT,
    "container_provider" TEXT,
    "container_id" TEXT,
    "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fleet_in_flight_slot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fleet_in_flight_slot_workload_ref_key" ON "fleet_in_flight_slot"("workload", "ref");

-- CreateIndex
CREATE INDEX "fleet_in_flight_slot_workload_expires_at_idx" ON "fleet_in_flight_slot"("workload", "expires_at");

-- ===========================================================================
-- Row-level security — fleet_in_flight_slot
-- ===========================================================================
-- NOT tenant data and NOT workspace-scoped, for the same reason its sibling
-- `ci_fleet_admission_lock` is not: this table exists to bound MOTIR'S OWN
-- infrastructure spend across every tenant at once, so the set it describes is
-- cross-tenant by definition. `organization_id` / `workspace_id` are carried for
-- ATTRIBUTION in an operator's breakdown of who is filling the fleet — they are
-- deliberately NOT a tenancy boundary, and reading this table per-workspace
-- would answer a question nobody asks while making the ceiling's own read
-- (unscoped, under the `fleet` lock) the exception rather than the rule.
--
-- So the policy is the narrow one — `app.system_admin` and nothing else — which
-- is also exactly the reach every caller has: CI admission, the index dispatch
-- (MOTIR-1990) and Epic 9's agent dispatch all run under `withSystemContext`,
-- because none of them has a session or an active workspace. A tenant request
-- can therefore never read, insert or delete a slot, which is the property that
-- matters: a row a tenant could delete would be a way to mint fleet capacity.
--
-- ENABLE + FORCE so even the table-owner `prodect` role is subject to it
-- (production and the service writes connect as the non-BYPASSRLS `prodect_app`
-- role). The workspace RLS migration's `ALTER DEFAULT PRIVILEGES … TO
-- prodect_app` auto-grants on every NEW table created by the `prodect` role, so
-- no explicit GRANT is needed.
ALTER TABLE "fleet_in_flight_slot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fleet_in_flight_slot" FORCE ROW LEVEL SECURITY;

CREATE POLICY "fleet_in_flight_slot_system_only" ON "fleet_in_flight_slot"
  FOR ALL
  USING (current_setting('app.system_admin', true) = 'true')
  WITH CHECK (current_setting('app.system_admin', true) = 'true');
