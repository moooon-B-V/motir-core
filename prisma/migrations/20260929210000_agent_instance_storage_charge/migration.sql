-- AN AGENT INSTANCE'S STORAGE, CHARGED ONCE PER UTC DAY (Story MOTIR-6914 ·
-- MOTIR-6919), specified by `docs/decisions/agent-instance-storage.md` §2.
--
-- One row per (instance, UTC day) on which the instance existed at any moment.
-- The daily charge writes the row BEFORE it asks motir-ai, so a debit motir-ai
-- could not take stays `pending` and is asked again with the SAME key on the next
-- pass — the interval charge's shape (`agent_instance_interval.charge_*`), reusing
-- its outcome enum. `charge_reference` (`agent-storage:<instance id>:<day>`) is
-- UNIQUE, so the database refuses a second row for one instance on one day.
--
-- Workspace-scoped tenant data, so RLS lands in THIS migration (no unguarded
-- window) and `workspace_id` is carried on the row, because RLS does not traverse
-- foreign keys. Every FK is modelled as a Prisma `@relation` on both sides with
-- the same actions, so `migrate diff` reports no drift.

-- CreateTable
CREATE TABLE "agent_instance_storage_charge" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "agent_instance_id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "credits" INTEGER NOT NULL,
    "charge_reference" TEXT NOT NULL,
    "charge_outcome" "agent_instance_charge_outcome" NOT NULL DEFAULT 'pending',
    "charge_detail" TEXT,
    "charge_attempts" INTEGER NOT NULL DEFAULT 0,
    "charged_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_instance_storage_charge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_instance_storage_charge_charge_reference_key" ON "agent_instance_storage_charge"("charge_reference");

-- CreateIndex
CREATE INDEX "agent_instance_storage_charge_charge_outcome_day_idx" ON "agent_instance_storage_charge"("charge_outcome", "day");

-- CreateIndex
CREATE INDEX "agent_instance_storage_charge_workspace_id_idx" ON "agent_instance_storage_charge"("workspace_id");

-- AddForeignKey
ALTER TABLE "agent_instance_storage_charge" ADD CONSTRAINT "agent_instance_storage_charge_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_instance_storage_charge" ADD CONSTRAINT "agent_instance_storage_charge_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_instance_storage_charge" ADD CONSTRAINT "agent_instance_storage_charge_agent_instance_id_fkey" FOREIGN KEY ("agent_instance_id") REFERENCES "agent_instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS, in the same migration as the table. FORCE so even the table owner is
-- subject to it. The gate is the row's OWN `workspace_id`. The workspace RLS
-- migration's `ALTER DEFAULT PRIVILEGES` auto-grants the runtime role on every
-- new table, so no explicit GRANT is needed.
ALTER TABLE "agent_instance_storage_charge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_instance_storage_charge" FORCE ROW LEVEL SECURITY;

CREATE POLICY "agent_instance_storage_charge_active_workspace" ON "agent_instance_storage_charge"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

-- A SYSTEM READ ARM, `FOR SELECT` only — `agent_instance_interval_system_read`'s
-- shape. The charge pass's discovery of rows still `pending` spans tenants BY
-- DESIGN and has no single workspace to bind; every WRITE re-binds to the row's
-- own workspace, so nothing is written untenanted. PERMISSIVE, so it is OR-ed
-- with the workspace policy and a tenant read is unaffected.
CREATE POLICY "agent_instance_storage_charge_system_read" ON "agent_instance_storage_charge"
  FOR SELECT
  USING (current_setting('app.system_admin', true) = 'true');
