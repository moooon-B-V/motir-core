-- AN AGENT'S BOOT, RECORDED STEP BY STEP (Story MOTIR-7393 · MOTIR-7397),
-- specified by `docs/decisions/agent-instances.md` AMENDMENT 6.
--
-- `agent_instance_boot_attempt` is one row per create and per wake, numbered per
-- agent (UNIQUE (agent_instance_id, attempt)), and carries the LEASE the boot
-- driver takes with a guarded compare-and-set: only its holder writes steps.
-- `agent_instance_boot_step` is one row per step of an attempt; every write
-- stamps a `seq`, monotonic per agent, which the boot stream resumes from.
--
-- Workspace-scoped tenant data, so RLS lands in THIS migration (no unguarded
-- window) and `workspace_id` is carried on both rows, because RLS does not
-- traverse foreign keys. Every FK is modelled as a Prisma `@relation` on both
-- sides with the same actions, so `migrate diff` reports no drift.


-- CreateEnum
CREATE TYPE "agent_instance_boot_kind" AS ENUM ('create', 'wake');

-- CreateEnum
CREATE TYPE "agent_instance_boot_outcome" AS ENUM ('running', 'failed', 'deleted');

-- CreateEnum
CREATE TYPE "agent_instance_boot_step_kind" AS ENUM ('provision', 'machine_start', 'clone', 'terminal_check', 'ready');

-- CreateEnum
CREATE TYPE "agent_instance_boot_step_state" AS ENUM ('waiting', 'in_progress', 'done', 'failed', 'skipped');

-- CreateTable
CREATE TABLE "agent_instance_boot_attempt" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "agent_instance_id" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "kind" "agent_instance_boot_kind" NOT NULL,
    "lease_holder" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "outcome" "agent_instance_boot_outcome",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_instance_boot_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_instance_boot_step" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "boot_attempt_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "step" "agent_instance_boot_step_kind" NOT NULL,
    "repository" TEXT,
    "ordinal" INTEGER NOT NULL,
    "state" "agent_instance_boot_step_state" NOT NULL,
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_instance_boot_step_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_instance_boot_attempt_workspace_id_idx" ON "agent_instance_boot_attempt"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_instance_boot_attempt_agent_instance_id_attempt_key" ON "agent_instance_boot_attempt"("agent_instance_id", "attempt");

-- CreateIndex
CREATE INDEX "agent_instance_boot_step_boot_attempt_id_seq_idx" ON "agent_instance_boot_step"("boot_attempt_id", "seq");

-- CreateIndex
CREATE INDEX "agent_instance_boot_step_workspace_id_idx" ON "agent_instance_boot_step"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_instance_boot_step_boot_attempt_id_ordinal_key" ON "agent_instance_boot_step"("boot_attempt_id", "ordinal");

-- AddForeignKey
ALTER TABLE "agent_instance_boot_attempt" ADD CONSTRAINT "agent_instance_boot_attempt_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_instance_boot_attempt" ADD CONSTRAINT "agent_instance_boot_attempt_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_instance_boot_attempt" ADD CONSTRAINT "agent_instance_boot_attempt_agent_instance_id_fkey" FOREIGN KEY ("agent_instance_id") REFERENCES "agent_instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_instance_boot_step" ADD CONSTRAINT "agent_instance_boot_step_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_instance_boot_step" ADD CONSTRAINT "agent_instance_boot_step_boot_attempt_id_fkey" FOREIGN KEY ("boot_attempt_id") REFERENCES "agent_instance_boot_attempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- RLS, in the same migration as the tables. FORCE so even the table owner is
-- subject to it. The gate is each row's OWN `workspace_id`. The workspace RLS
-- migration's `ALTER DEFAULT PRIVILEGES` auto-grants the runtime role on every
-- new table, so no explicit GRANT is needed.
ALTER TABLE "agent_instance_boot_attempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_instance_boot_attempt" FORCE ROW LEVEL SECURITY;

CREATE POLICY "agent_instance_boot_attempt_active_workspace" ON "agent_instance_boot_attempt"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

ALTER TABLE "agent_instance_boot_step" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_instance_boot_step" FORCE ROW LEVEL SECURITY;

CREATE POLICY "agent_instance_boot_step_active_workspace" ON "agent_instance_boot_step"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

-- A SYSTEM READ ARM on each, `FOR SELECT` only — `agent_instance_interval_system_read`'s
-- shape. The boot driver and the sweep's lease check read a boot by the agent's
-- id with no workspace bound, as `settleBoot` reads the agent; every WRITE
-- re-binds to the row's own workspace. PERMISSIVE, so it is OR-ed with the
-- workspace policy and a tenant read is unaffected.
CREATE POLICY "agent_instance_boot_attempt_system_read" ON "agent_instance_boot_attempt"
  FOR SELECT
  USING (current_setting('app.system_admin', true) = 'true');

CREATE POLICY "agent_instance_boot_step_system_read" ON "agent_instance_boot_step"
  FOR SELECT
  USING (current_setting('app.system_admin', true) = 'true');
