-- THE FLEET'S COST METER (Story MOTIR-1916 · MOTIR-1924) — the SECOND meter, and
-- the first thing in Motir that measures what Motir's OWN compute costs.
--
-- `docs/decisions/ci-minutes-allowance.md` §P: before the runner fleet, "what
-- the customer is charged" and "what Motir pays" were one number seen from two
-- sides, because GitHub billed Motir for the minute it charged the user for. On
-- Motir's own runners they are independent quantities with two meters, and only
-- the first was measured — the 9.0 gateway meters TOKENS, `ci_workflow_run_usage`
-- meters Actions job WALL-CLOCK, and neither sees a container.
--
--   * `ci_container_usage`      — one row per RUNNER: container-seconds and the
--                                 USD they cost, at the rate in force when the
--                                 container ran (`ci-runner-fleet.md` §5; the
--                                 fields are fixed there, the schema is here).
--   * `ci_container_period_cost` — the (workspace, month) rollup, so "what did
--                                 this org's CI cost Motir?" is one indexed read
--                                 rather than a scan over every container.
--
-- ⚠️ NOTHING HERE IS BILLING. No credit is debited, no balance read, nothing
-- refused, nothing user-facing: this is Motir's own COGS. Paired with
-- `ci_period_usage` on the same (organization_id, period_start) key, it is what
-- turns §L's margin claim and §M's ×1.00 cost ESTIMATE into measurements — the
-- stated precondition for ever re-opening the allowance, in the open and with
-- its own card.
--
-- ⚠️ MONEY IS DECIMAL, NEVER FLOAT. `usd_per_second` is ~3×10⁻⁵ and the second
-- counts run to five digits; in binary floating point that product's error is
-- invisible per row and systematic across a month — precisely the error a
-- reconciliation is worst at catching.

-- CreateTable
CREATE TABLE "ci_container_usage" (
    "id" TEXT NOT NULL,
    "container_provider" TEXT NOT NULL,
    "handle_id" TEXT NOT NULL,
    "container_region" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "project_id" TEXT,
    "workload" TEXT NOT NULL DEFAULT 'ci',
    "repo_full_name" TEXT NOT NULL,
    "workflow_job_id" TEXT,
    "cpu_kind" TEXT NOT NULL,
    "cpus" INTEGER NOT NULL,
    "memory_mb" INTEGER NOT NULL,
    "container_created_at" TIMESTAMP(3) NOT NULL,
    "container_started_at" TIMESTAMP(3),
    "container_stopped_at" TIMESTAMP(3),
    "billable_seconds" INTEGER NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "usd_per_second" DECIMAL(20,12) NOT NULL,
    "cost_usd" DECIMAL(20,12) NOT NULL,
    "rate_effective_from" TIMESTAMP(3),
    "terminal_state" TEXT,
    "teardown_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ci_container_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ci_container_period_cost" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "container_seconds" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(24,12) NOT NULL DEFAULT 0,
    "container_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ci_container_period_cost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ci_container_usage_workspace_id_idx" ON "ci_container_usage"("workspace_id");

-- CreateIndex
CREATE INDEX "ci_container_usage_organization_id_period_start_idx" ON "ci_container_usage"("organization_id", "period_start");

-- CreateIndex
CREATE INDEX "ci_container_usage_period_start_idx" ON "ci_container_usage"("period_start");

-- CreateIndex
CREATE INDEX "ci_container_usage_project_id_idx" ON "ci_container_usage"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "ci_container_usage_container_provider_handle_id_key" ON "ci_container_usage"("container_provider", "handle_id");

-- CreateIndex
CREATE INDEX "ci_container_period_cost_organization_id_period_start_idx" ON "ci_container_period_cost"("organization_id", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "ci_container_period_cost_workspace_id_period_start_key" ON "ci_container_period_cost"("workspace_id", "period_start");

-- AddForeignKey
ALTER TABLE "ci_container_usage" ADD CONSTRAINT "ci_container_usage_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ci_container_usage" ADD CONSTRAINT "ci_container_usage_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ci_container_usage" ADD CONSTRAINT "ci_container_usage_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ci_container_period_cost" ADD CONSTRAINT "ci_container_period_cost_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ci_container_period_cost" ADD CONSTRAINT "ci_container_period_cost_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- Row-level security — ci_container_usage + ci_container_period_cost
-- ===========================================================================
-- Workspace-scoped tenant data, so `workspace_id` is non-null and the policies
-- ship in THIS migration (PRODECT_FINDINGS #20 — no unguarded window). ENABLE +
-- FORCE so even the table-owner `prodect` role is subject to them (production
-- and the service writes connect as the non-BYPASSRLS `prodect_app` role).
--
-- WHY TENANT DATA AT ALL, when this is MOTIR'S cost rather than the tenant's
-- bill: because it is commercially sensitive in BOTH directions. A row says how
-- much a tenant builds and what serving them costs, so one tenant reading
-- another's would be a real leak — and it is the same posture `ci_period_usage`
-- takes for the same shape of fact one meter over.
--
-- Both carry the `app.system_admin` escape hatch — the `ci_workflow_run_usage`
-- shape, for the identical reason: the ONLY writer is the fleet ORCHESTRATOR
-- (the teardown path and the reaper), which runs as a background job with no
-- session and no active workspace, under `withSystemContext`. Without the hatch
-- the fleet could not record what it spent.
--
-- The gate is the row's OWN `workspace_id` — RLS does not traverse foreign keys,
-- so the `organization_id` column (denormalized so the margin read is one
-- indexed query) grants no access by itself: a tenant still only ever sees rows
-- carrying its own workspace.
--
-- The workspace RLS migration's `ALTER DEFAULT PRIVILEGES … TO prodect_app`
-- auto-grants on every NEW table created by the `prodect` role, so no explicit
-- GRANT is needed.
ALTER TABLE "ci_container_usage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ci_container_usage" FORCE ROW LEVEL SECURITY;

CREATE POLICY "ci_container_usage_workspace_or_system" ON "ci_container_usage"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  );

ALTER TABLE "ci_container_period_cost" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ci_container_period_cost" FORCE ROW LEVEL SECURITY;

CREATE POLICY "ci_container_period_cost_workspace_or_system" ON "ci_container_period_cost"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  );
