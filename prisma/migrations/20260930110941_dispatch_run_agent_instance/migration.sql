-- Story MOTIR-6864 · MOTIR-7023 — the run record knows its agent
-- (`docs/decisions/agent-instance-run.md` §5).
--
-- A run in one of the developer's own agents is `origin = 'instance'` and names
-- the agent on `agent_instance_id`. Existing `local` / `hosted` rows keep a null
-- agent and read back unchanged.

-- The new origin. Appended: the enum's declaration order carries no meaning.
-- ⚠️ The value is NOT used as an enum literal anywhere in this migration (the
-- CHECK below compares `origin::text`): PostgreSQL refuses a value added by
-- `ADD VALUE` being used in the same transaction.
ALTER TYPE "dispatch_run_origin" ADD VALUE IF NOT EXISTS 'instance';

-- AlterTable
ALTER TABLE "dispatch_run" ADD COLUMN     "agent_instance_id" TEXT;

-- AddForeignKey — modelled as `DispatchRun.agentInstance` ↔
-- `AgentInstance.dispatchRuns`. SET NULL: removing an agent never deletes run
-- history.
ALTER TABLE "dispatch_run" ADD CONSTRAINT "dispatch_run_agent_instance_id_fkey" FOREIGN KEY ("agent_instance_id") REFERENCES "agent_instance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AT MOST ONE RUNNING RUN PER AGENT, enforced by the database (§5). Two
-- concurrent starts both pass the service's read; the loser's insert fails here
-- with a unique violation the service translates to
-- `DispatchRunAgentBusyError` (`agent_instance_run_active`).
--
-- ⚠️ A PARTIAL index is inexpressible in the datamodel, so no `@@index` /
-- `@@unique` on `DispatchRun` may claim the column list `(agent_instance_id)` —
-- Prisma's differ would pair the two and report a permanent spurious RENAME
-- (CLAUDE.md, the partial-index rule). The index doubles as the active-run read
-- by agent (`findRunningByAgentInstance(s)`), whose filter it matches exactly.
CREATE UNIQUE INDEX "dispatch_run_agent_instance_running_key"
  ON "dispatch_run" ("agent_instance_id")
  WHERE "status" = 'running' AND "agent_instance_id" IS NOT NULL;

-- Only an `instance` run names an agent. ONE direction on purpose: the FK is
-- `ON DELETE SET NULL`, so an `instance` run whose agent row was removed keeps
-- its origin with a null agent — the history exception §5 leaves open. The
-- other direction (an `instance` run always names its agent at OPEN) is the
-- service's: `dispatchRunService.openWithin` refuses an `instance` open with no
-- agent.
ALTER TABLE "dispatch_run" ADD CONSTRAINT "dispatch_run_agent_instance_origin_check"
  CHECK ("agent_instance_id" IS NULL OR "origin"::text = 'instance');
