-- CreateEnum
CREATE TYPE "fleet_shard_provider" AS ENUM ('fly');

-- CreateEnum
CREATE TYPE "fleet_shard_role" AS ENUM ('primary');

-- CreateEnum
CREATE TYPE "fleet_shard_state" AS ENUM ('provisioning', 'active', 'disabled');

-- CreateTable
CREATE TABLE "fleet_shard" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fleet_kind" TEXT NOT NULL,
    "provider" "fleet_shard_provider" NOT NULL,
    "role" "fleet_shard_role" NOT NULL DEFAULT 'primary',
    "state" "fleet_shard_state" NOT NULL DEFAULT 'provisioning',
    "github_org" TEXT NOT NULL,
    "github_installation_id" TEXT NOT NULL,
    "github_app_role" TEXT NOT NULL DEFAULT 'provisioning',
    "fly_org" TEXT,
    "fly_app" TEXT,
    "fly_region" TEXT,
    "credential_ref" TEXT NOT NULL,
    "vcpu_quota" INTEGER,
    "machine_limit" INTEGER,
    "github_registrations_per_5_min" INTEGER,
    "github_api_per_hour" INTEGER,
    "limits_source" JSONB NOT NULL DEFAULT '{}',
    "limits_verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fleet_shard_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fleet_shard_name_key" ON "fleet_shard"("name");

-- CreateIndex
CREATE INDEX "fleet_shard_fleet_kind_role_state_idx" ON "fleet_shard"("fleet_kind", "role", "state");

-- CreateIndex
CREATE UNIQUE INDEX "fleet_shard_provider_fly_org_fly_app_key" ON "fleet_shard"("provider", "fly_org", "fly_app");


-- ===========================================================================
-- THE INVARIANTS, held by the database (MOTIR-8961). `fleetShardService`
-- refuses the same rows first with typed errors; these are what make a direct
-- write that skips the service fail too.

-- Every account is in exactly one fleet kind's pool: one of the four
-- `FLEET_WORKLOADS` names in `lib/ciFleet/workloads.ts`.
ALTER TABLE "fleet_shard" ADD CONSTRAINT "fleet_shard_fleet_kind_check"
  CHECK ("fleet_kind" IN ('ci_runner', 'code_graph_index', 'hosted_agent', 'agent_instance'));

-- A Fly account names its location and its machine limit.
ALTER TABLE "fleet_shard" ADD CONSTRAINT "fleet_shard_fly_location_check"
  CHECK (
    "provider" <> 'fly'
    OR ("fly_org" IS NOT NULL AND "fly_app" IS NOT NULL AND "fly_region" IS NOT NULL
        AND "machine_limit" IS NOT NULL)
  );

-- A limit that is recorded is a real one.
ALTER TABLE "fleet_shard" ADD CONSTRAINT "fleet_shard_limits_positive_check"
  CHECK (
    ("vcpu_quota" IS NULL OR "vcpu_quota" > 0)
    AND ("machine_limit" IS NULL OR "machine_limit" > 0)
    AND ("github_registrations_per_5_min" IS NULL OR "github_registrations_per_5_min" > 0)
    AND ("github_api_per_hour" IS NULL OR "github_api_per_hour" > 0)
  );

-- ===========================================================================
-- Platform infrastructure, read and written only by the fleet path and the
-- platform admin under `withSystemContext` — no tenant surface reads it. So the
-- policy is the narrow one `fleet_in_flight_slot` uses: `app.system_admin` and
-- nothing else.
ALTER TABLE "fleet_shard" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fleet_shard" FORCE ROW LEVEL SECURITY;

CREATE POLICY "fleet_shard_system_only" ON "fleet_shard"
  FOR ALL
  USING (current_setting('app.system_admin', true) = 'true')
  WITH CHECK (current_setting('app.system_admin', true) = 'true');
