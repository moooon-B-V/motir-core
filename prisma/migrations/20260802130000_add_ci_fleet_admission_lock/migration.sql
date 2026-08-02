-- CreateTable
CREATE TABLE "ci_fleet_admission_lock" (
    "scope" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ci_fleet_admission_lock_pkey" PRIMARY KEY ("scope")
);

-- ===========================================================================
-- Row-level security — ci_fleet_admission_lock
-- ===========================================================================
-- NOT tenant data and NOT workspace-scoped: the rows carry no columns beyond
-- their own name, and the `fleet` scope is cross-tenant by definition (it is
-- what bounds Motir's OWN infrastructure spend). So the policy is the narrow
-- one — `app.system_admin` and nothing else — rather than the workspace shape
-- its sibling `ci_runner_provisioning_intent` uses.
--
-- That is also exactly the reach the only caller has: the admission gate runs
-- under `withSystemContext`, like every other step of the fleet path, because a
-- `workflow_job` webhook has no session and no active workspace. A tenant
-- request can therefore never take (or wait on) one of these locks, which is the
-- property that matters — a lock a tenant could contend on would be a
-- cross-tenant denial-of-service surface, not a cap.
--
-- ENABLE + FORCE so even the table-owner `prodect` role is subject to it
-- (production and the service writes connect as the non-BYPASSRLS `prodect_app`
-- role). The workspace RLS migration's `ALTER DEFAULT PRIVILEGES … TO
-- prodect_app` auto-grants on every NEW table created by the `prodect` role, so
-- no explicit GRANT is needed.
ALTER TABLE "ci_fleet_admission_lock" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ci_fleet_admission_lock" FORCE ROW LEVEL SECURITY;

CREATE POLICY "ci_fleet_admission_lock_system_only" ON "ci_fleet_admission_lock"
  FOR ALL
  USING (current_setting('app.system_admin', true) = 'true')
  WITH CHECK (current_setting('app.system_admin', true) = 'true');
