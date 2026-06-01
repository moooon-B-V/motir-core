-- Background-job run ledger (Story 1.6 · Subtask 1.6.2). The durable read path
-- the operator dashboard (1.6.5) renders without calling Inngest's API. The
-- `defineJob` wrapper writes a `running` row at start and flips it to
-- `succeeded` / `failed` at the end of each run.
--
-- NO row-level security in this migration — RLS is DEFERRED to 1.6.4, which
-- folds the job_run policy in alongside the dead-letter-queue table so both
-- land in ONE atomic migration-by-concern (PRODECT_FINDINGS #20's "table + its
-- policy in one migration" lesson, deliberately batched with the DLQ work).
-- Until then job_run is reached ONLY through the trusted server-side wrapper,
-- never a tenant-facing query path. `workspace_id` is nullable because system
-- jobs (system.ping here) are untenanted.

-- CreateEnum
CREATE TYPE "job_run_status" AS ENUM ('running', 'succeeded', 'failed');

-- CreateTable
CREATE TABLE "job_run" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "function_id" TEXT NOT NULL,
    "event_name" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" "job_run_status" NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "failure" JSONB,
    "idempotency_key" TEXT,

    CONSTRAINT "job_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "job_run_workspace_id_started_at_idx" ON "job_run"("workspace_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "job_run_workspace_id_status_started_at_idx" ON "job_run"("workspace_id", "status", "started_at" DESC);

-- CreateIndex
CREATE INDEX "job_run_event_id_idx" ON "job_run"("event_id");

-- CreateIndex
CREATE INDEX "job_run_idempotency_key_idx" ON "job_run"("idempotency_key");

-- AddForeignKey
ALTER TABLE "job_run" ADD CONSTRAINT "job_run_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
