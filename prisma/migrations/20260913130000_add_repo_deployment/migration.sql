-- PREVIEW DEPLOYMENTS a repository's own host reports (Story MOTIR-4906 ·
-- Subtask MOTIR-5329). ADDITIVE and in ONE step — table + indexes + FKs + RLS —
-- so it ships in one deploy with no unguarded window.
--
-- Motir only LISTENS: `githubWebhookService.handleDeploymentStatus` (and GitLab's
-- `deployment` hook, MOTIR-5332) upsert here and make no outbound call.
--
-- RLS shape = `github_check_run`'s, simplified by the row carrying its own
-- `workspace_id` (no join through the pull request):
--   · `repo_deployment_workspace_or_system` (FOR ALL) — the webhook writes under
--     withSystemContext (a delivery has no tenant session), and a tenant reader
--     sees its own workspace's rows;
--   · `repo_deployment_org_read` (FOR SELECT) — the organisation-tier read, since a
--     repository is connected ONCE to the organisation (MOTIR-4649). It resolves
--     the caller's org through the uncorrelated `(SELECT app_caller_organization_id())`
--     InitPlan, never a per-row EXISTS (the RLS per-row-tax lesson, MOTIR-4669).

-- CreateTable
CREATE TABLE "repo_deployment" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "repo_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_deployment_id" TEXT NOT NULL,
    "commit_sha" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "environment_url" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repo_deployment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "repo_deployment_repo_id_commit_sha_idx" ON "repo_deployment"("repo_id", "commit_sha");

-- CreateIndex
CREATE INDEX "repo_deployment_repo_id_ref_idx" ON "repo_deployment"("repo_id", "ref");

-- CreateIndex
CREATE INDEX "repo_deployment_workspace_id_idx" ON "repo_deployment"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "repo_deployment_repo_id_provider_provider_deployment_id_key" ON "repo_deployment"("repo_id", "provider", "provider_deployment_id");

-- AddForeignKey
ALTER TABLE "repo_deployment" ADD CONSTRAINT "repo_deployment_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repo_deployment" ADD CONSTRAINT "repo_deployment_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "github_repo"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "repo_deployment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "repo_deployment" FORCE ROW LEVEL SECURITY;

CREATE POLICY "repo_deployment_workspace_or_system" ON "repo_deployment"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  );

CREATE POLICY "repo_deployment_org_read" ON "repo_deployment"
  FOR SELECT
  USING (
    "repo_id" IN (
      SELECT r."id" FROM "github_repo" r
       WHERE r."organization_id" = (SELECT app_caller_organization_id())
          OR r."organization_id" = (SELECT current_setting('app.organization_id', true))
    )
  );
