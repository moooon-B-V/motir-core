-- The CI-MINUTES METER (Story MOTIR-1775 · MOTIR-1896) — the MEASUREMENT half of
-- the CI-charging contract recorded in `docs/decisions/ci-minutes-allowance.md`.
--
-- Motir creates every new project's repositories in its OWN GitHub org (the
-- repo-set ADR §3, after the MOTIR-1893 amendment), and private-repo Actions
-- minutes bill to the REPOSITORY OWNER — so Motir pays for those users' CI from
-- the first `motir run` onward. These two tables measure that spend and attribute
-- it, so the allowance sibling (MOTIR-1901) can ask ONE question: "how many
-- Linux-equivalent minutes has org X used this period?"
--
-- `ci_workflow_run_usage` is the per-run AUDIT row; `ci_period_usage` is the
-- per-(workspace, calendar-month) ROLLUP that makes the sibling's read a single
-- indexed lookup instead of a scan-and-sum over all history. Both are written in
-- one transaction, so they can never disagree.
--
-- Nothing here debits credits, reads a balance or refuses a dispatch.

-- CreateTable
CREATE TABLE "ci_workflow_run_usage" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'github',
    "workspace_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "project_id" TEXT,
    "github_repo_id" TEXT,
    "run_id" TEXT NOT NULL,
    "run_attempt" INTEGER NOT NULL,
    "repo_owner" TEXT NOT NULL,
    "repo_name" TEXT NOT NULL,
    "workflow_name" TEXT,
    "period_start" TIMESTAMP(3) NOT NULL,
    "run_completed_at" TIMESTAMP(3) NOT NULL,
    "billable_minutes" INTEGER NOT NULL,
    "raw_wall_clock_seconds" DECIMAL(12,2) NOT NULL,
    "linear_equivalent_minutes" DECIMAL(12,2) NOT NULL,
    "job_count" INTEGER NOT NULL,
    "runner_breakdown" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ci_workflow_run_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ci_period_usage" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "linear_equivalent_minutes" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "billable_minutes" INTEGER NOT NULL DEFAULT 0,
    "raw_wall_clock_seconds" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "run_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ci_period_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ci_workflow_run_usage_workspace_id_idx" ON "ci_workflow_run_usage"("workspace_id");

-- CreateIndex
CREATE INDEX "ci_workflow_run_usage_organization_id_period_start_idx" ON "ci_workflow_run_usage"("organization_id", "period_start");

-- CreateIndex
CREATE INDEX "ci_workflow_run_usage_project_id_idx" ON "ci_workflow_run_usage"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "ci_workflow_run_usage_run_id_run_attempt_key" ON "ci_workflow_run_usage"("run_id", "run_attempt");

-- CreateIndex
CREATE INDEX "ci_period_usage_organization_id_period_start_idx" ON "ci_period_usage"("organization_id", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "ci_period_usage_workspace_id_period_start_key" ON "ci_period_usage"("workspace_id", "period_start");

-- AddForeignKey
ALTER TABLE "ci_workflow_run_usage" ADD CONSTRAINT "ci_workflow_run_usage_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ci_workflow_run_usage" ADD CONSTRAINT "ci_workflow_run_usage_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ci_workflow_run_usage" ADD CONSTRAINT "ci_workflow_run_usage_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ci_workflow_run_usage" ADD CONSTRAINT "ci_workflow_run_usage_github_repo_id_fkey" FOREIGN KEY ("github_repo_id") REFERENCES "github_repo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ci_period_usage" ADD CONSTRAINT "ci_period_usage_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ci_period_usage" ADD CONSTRAINT "ci_period_usage_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- Row-level security — ci_workflow_run_usage + ci_period_usage
-- ===========================================================================
-- Workspace-scoped tenant data, so `workspace_id` is non-null and the policy
-- ships in THIS migration (PRODECT_FINDINGS #20 — no unguarded window). ENABLE +
-- FORCE so even the table-owner `prodect` role is subject to it (production and
-- the service writes connect as the non-BYPASSRLS `prodect_app` role).
--
-- These carry the `app.system_admin` escape hatch — the `github_repo` /
-- `attachment` shape, NOT the pure workspace gate `project_repository` uses.
-- The difference is real and is the reason the hatch exists at all: every write
-- to `project_repository` comes from a REQUEST path with an active workspace,
-- whereas the meter's writer is the GitHub `workflow_run` WEBHOOK, which has no
-- session and no active workspace and therefore runs under `withSystemContext`.
-- Without the hatch the meter could not write its own rows.
--
-- The gate is the row's OWN `workspace_id` — RLS does not traverse foreign keys,
-- so the `organization_id` column (denormalized for the allowance sibling's
-- indexed read) grants no access by itself: a tenant reading its org's
-- consumption still only ever sees rows carrying its own workspace.
--
-- The workspace RLS migration's `ALTER DEFAULT PRIVILEGES … TO prodect_app`
-- auto-grants on every NEW table created by the `prodect` role, so no explicit
-- GRANT is needed.
ALTER TABLE "ci_workflow_run_usage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ci_workflow_run_usage" FORCE ROW LEVEL SECURITY;

CREATE POLICY "ci_workflow_run_usage_workspace_or_system" ON "ci_workflow_run_usage"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  );

ALTER TABLE "ci_period_usage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ci_period_usage" FORCE ROW LEVEL SECURITY;

CREATE POLICY "ci_period_usage_workspace_or_system" ON "ci_period_usage"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  );
