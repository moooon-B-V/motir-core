-- USER AGENT INSTANCES (Story MOTIR-6860 · MOTIR-6870), specified by
-- `docs/decisions/agent-instances.md` §4 (MOTIR-6866).
--
-- Two tables: the INSTANCE — one developer's long-lived machine and its home
-- volume on one project — and one row per RUNNING INTERVAL, the stretch from a
-- create or wake to a hibernate or delete. The interval is what is charged, so
-- it is its own row: an instance woken three times is three charges, and a
-- charge keyed on the interval (`charge_reference`) is idempotent per stretch.
--
-- Workspace-scoped tenant data, so RLS lands in THIS migration (no unguarded
-- window) and `workspace_id` is carried on BOTH tables, because RLS does not
-- traverse foreign keys. Every FK is modelled as a Prisma `@relation` on both
-- sides with the same actions, so `migrate diff` reports no drift.
--
-- The two PARTIAL unique indexes are corruption the DATABASE refuses rather
-- than "the service checks first", and each has a column list no `@@index`
-- claims (motir-core/CLAUDE.md, the partial-index rule):
--   * one LIVE instance per (owner, project, name) — a deleted instance keeps
--     its row for its intervals' sake (§4), so its name must be free to reuse;
--   * at most ONE OPEN interval per instance — two open intervals would be one
--     running machine charged twice.
-- CreateEnum
CREATE TYPE "agent_instance_state" AS ENUM ('starting', 'running', 'hibernating', 'hibernated', 'waking', 'failed', 'deleting');

-- CreateEnum
CREATE TYPE "agent_instance_interval_end_reason" AS ENUM ('hibernated', 'idle', 'backstop', 'credits', 'deleted', 'lost', 'rolled');

-- CreateEnum
CREATE TYPE "agent_instance_charge_outcome" AS ENUM ('pending', 'charged', 'not_charged', 'refused');

-- CreateTable
CREATE TABLE "agent_instance" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "image_tag" TEXT NOT NULL,
    "image_digest" TEXT NOT NULL,
    "fly_app" TEXT,
    "machine_id" TEXT,
    "volume_id" TEXT,
    "region" TEXT NOT NULL,
    "state" "agent_instance_state" NOT NULL DEFAULT 'starting',
    "failure_reason" TEXT,
    "state_changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_instance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_instance_interval" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "agent_instance_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "run_started_at" TIMESTAMP(3) NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "end_reason" "agent_instance_interval_end_reason",
    "billable_seconds" INTEGER,
    "credits" INTEGER,
    "charge_reference" TEXT NOT NULL,
    "charge_outcome" "agent_instance_charge_outcome",
    "charge_detail" TEXT,
    "charge_attempts" INTEGER NOT NULL DEFAULT 0,
    "charged_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_instance_interval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_instance_owner_id_project_id_created_at_idx" ON "agent_instance"("owner_id", "project_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "agent_instance_state_organization_id_idx" ON "agent_instance"("state", "organization_id");

-- CreateIndex
CREATE INDEX "agent_instance_workspace_id_idx" ON "agent_instance"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_instance_interval_charge_reference_key" ON "agent_instance_interval"("charge_reference");

-- CreateIndex
CREATE INDEX "agent_instance_interval_agent_instance_id_started_at_idx" ON "agent_instance_interval"("agent_instance_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "agent_instance_interval_charge_outcome_ended_at_idx" ON "agent_instance_interval"("charge_outcome", "ended_at");

-- CreateIndex
CREATE INDEX "agent_instance_interval_workspace_id_idx" ON "agent_instance_interval"("workspace_id");

-- AddForeignKey
ALTER TABLE "agent_instance" ADD CONSTRAINT "agent_instance_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_instance" ADD CONSTRAINT "agent_instance_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_instance" ADD CONSTRAINT "agent_instance_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_instance" ADD CONSTRAINT "agent_instance_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_instance_interval" ADD CONSTRAINT "agent_instance_interval_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_instance_interval" ADD CONSTRAINT "agent_instance_interval_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_instance_interval" ADD CONSTRAINT "agent_instance_interval_agent_instance_id_fkey" FOREIGN KEY ("agent_instance_id") REFERENCES "agent_instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- One LIVE instance per (owner, project, name).
CREATE UNIQUE INDEX "agent_instance_live_name_key" ON "agent_instance"("owner_id", "project_id", "name")
  WHERE "deleted_at" IS NULL;

-- At most one OPEN interval per instance.
CREATE UNIQUE INDEX "agent_instance_interval_one_open_key" ON "agent_instance_interval"("agent_instance_id")
  WHERE "ended_at" IS NULL;

-- An interval's end reason is set EXACTLY when it has ended — stated in both
-- directions, like `dispatch_run_card_skip_reason_iff_skipped`.
ALTER TABLE "agent_instance_interval"
  ADD CONSTRAINT "agent_instance_interval_end_reason_iff_ended"
  CHECK (("ended_at" IS NULL) = ("end_reason" IS NULL));

-- RLS, in the same migration as the tables. FORCE so even the table owner is
-- subject to it. The gate is each row's OWN `workspace_id`. The workspace RLS
-- migration's `ALTER DEFAULT PRIVILEGES` auto-grants the runtime role on every
-- new table, so no explicit GRANT is needed.
ALTER TABLE "agent_instance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_instance" FORCE ROW LEVEL SECURITY;

CREATE POLICY "agent_instance_active_workspace" ON "agent_instance"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

ALTER TABLE "agent_instance_interval" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_instance_interval" FORCE ROW LEVEL SECURITY;

CREATE POLICY "agent_instance_interval_active_workspace" ON "agent_instance_interval"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

-- A SYSTEM READ ARM, `FOR SELECT` only — the `dispatch_run_system_read` shape
-- (20260829130000). Three reads in this story span tenants BY DESIGN and have no
-- single workspace to bind: the fleet-wide running-instance cap (§6), the idle
-- sweep and reconcile's discovery (§2, §5), and the charge backstop's pass over
-- closed-but-uncharged intervals (§5). Every WRITE that follows re-binds to the
-- row's own workspace, so nothing is written untenanted. PERMISSIVE, so it is
-- OR-ed with the workspace policy and a tenant read is unaffected.
CREATE POLICY "agent_instance_system_read" ON "agent_instance"
  FOR SELECT
  USING (current_setting('app.system_admin', true) = 'true');

CREATE POLICY "agent_instance_interval_system_read" ON "agent_instance_interval"
  FOR SELECT
  USING (current_setting('app.system_admin', true) = 'true');
