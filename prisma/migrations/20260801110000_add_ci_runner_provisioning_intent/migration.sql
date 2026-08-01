-- The runner-FLEET provisioning INTENT (Story MOTIR-1916 · MOTIR-1920) — the
-- entry point of the ephemeral-runner fleet recorded in
-- `docs/decisions/ci-minutes-allowance.md`'s 2026-07-31 amendment (§J–§Q).
--
-- Project CI moves off GitHub-hosted runners onto Motir-operated ephemeral
-- self-hosted ones. The `workflow_job` `queued` webhook is where a job says it
-- needs a machine; this table is where that request becomes durable, so the
-- ack can be fast and MOTIR-1921's provisioner can crash, retry or be
-- redeployed between receipt and boot without dropping the job.
--
-- ⚠️ ONLY LABEL-SCOPED JOBS REACH THIS TABLE (§O). The same webhook receives a
-- `queued` event for every GitHub-hosted job in every installed repo — all 31
-- of `motir-core`'s own among them — and the handler drops each one before any
-- write. `requested_labels` records the evidence for the rows that survive.
--
-- Nothing here boots a runner, mints a token, or spends anything: this card
-- emits the intent and stops.

-- CreateTable
CREATE TABLE "ci_runner_provisioning_intent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'github',
    "workspace_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "project_id" TEXT,
    "github_repo_id" TEXT,
    "installation_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "run_attempt" INTEGER NOT NULL,
    "job_id" TEXT NOT NULL,
    "job_name" TEXT,
    "workflow_name" TEXT,
    "repo_owner" TEXT NOT NULL,
    "repo_name" TEXT NOT NULL,
    "requested_labels" TEXT[],
    "queued_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ci_runner_provisioning_intent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ci_runner_provisioning_intent_workspace_id_idx" ON "ci_runner_provisioning_intent"("workspace_id");

-- CreateIndex
CREATE INDEX "ci_runner_provisioning_intent_status_queued_at_idx" ON "ci_runner_provisioning_intent"("status", "queued_at");

-- CreateIndex
CREATE INDEX "ci_runner_provisioning_intent_organization_id_status_idx" ON "ci_runner_provisioning_intent"("organization_id", "status");

-- CreateIndex
CREATE INDEX "ci_runner_provisioning_intent_project_id_status_idx" ON "ci_runner_provisioning_intent"("project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ci_runner_provisioning_intent_run_id_run_attempt_job_id_key" ON "ci_runner_provisioning_intent"("run_id", "run_attempt", "job_id");

-- AddForeignKey
ALTER TABLE "ci_runner_provisioning_intent" ADD CONSTRAINT "ci_runner_provisioning_intent_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ci_runner_provisioning_intent" ADD CONSTRAINT "ci_runner_provisioning_intent_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ci_runner_provisioning_intent" ADD CONSTRAINT "ci_runner_provisioning_intent_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ci_runner_provisioning_intent" ADD CONSTRAINT "ci_runner_provisioning_intent_github_repo_id_fkey" FOREIGN KEY ("github_repo_id") REFERENCES "github_repo"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ===========================================================================
-- Row-level security — ci_runner_provisioning_intent
-- ===========================================================================
-- Workspace-scoped tenant data, so `workspace_id` is non-null and the policy
-- ships in THIS migration (PRODECT_FINDINGS #20 — no unguarded window). ENABLE +
-- FORCE so even the table-owner `prodect` role is subject to it (production and
-- the service writes connect as the non-BYPASSRLS `prodect_app` role).
--
-- It carries the `app.system_admin` escape hatch — the `ci_workflow_run_usage`
-- shape, for the identical reason: this table's ONLY writer is the GitHub
-- `workflow_job` WEBHOOK, which has no session and no active workspace and
-- therefore runs under `withSystemContext`. Without the hatch the fleet could
-- not record its own intents.
--
-- The gate is the row's OWN `workspace_id` — RLS does not traverse foreign keys,
-- so the `organization_id` column (denormalized for MOTIR-1922's per-org cap)
-- grants no access by itself: a tenant reading fleet activity still only ever
-- sees rows carrying its own workspace.
--
-- The workspace RLS migration's `ALTER DEFAULT PRIVILEGES … TO prodect_app`
-- auto-grants on every NEW table created by the `prodect` role, so no explicit
-- GRANT is needed.
ALTER TABLE "ci_runner_provisioning_intent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ci_runner_provisioning_intent" FORCE ROW LEVEL SECURITY;

CREATE POLICY "ci_runner_provisioning_intent_workspace_or_system" ON "ci_runner_provisioning_intent"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  );
