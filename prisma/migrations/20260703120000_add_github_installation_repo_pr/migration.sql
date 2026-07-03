-- GitHub App installation grant (Story 7.10 · MOTIR-891) — "Grant 2" of the
-- verified GitHub-App model + the PR→work-item link entities the rest of the
-- Story hangs off, behind the GitProvider seam. Each table lands WITH its RLS
-- policy so there is never an unguarded window.
--
-- RLS policy shapes:
--   * `github_installation` — workspace gate WITH a system-admin escape. Reads
--     run under `withWorkspaceContext` (the settings surface); WRITES come from
--     the `installation` webhook (MOTIR-892), which has no active workspace, so
--     it writes under `withSystemContext` (the api_token / job_run precedent):
--     USING + WITH CHECK admit a row when `app.system_admin = 'true'` OR the
--     row's `workspace_id` matches `app.workspace_id`.
--   * `github_repo` — NO `workspace_id` column by design (denormalizing it would
--     duplicate the installation's tenancy). The policy JOINS through the parent
--     `github_installation` and tests THAT row's `workspace_id` (the
--     `comment_mention` pattern), plus the same system-admin escape.
--   * `github_pull_request` — same, joining repo → installation.

-- CreateTable
CREATE TABLE "github_installation" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'github',
    "installation_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "account_login" TEXT NOT NULL,
    "account_type" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_installation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_repo" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'github',
    "installation_id" TEXT NOT NULL,
    "repo_id" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "default_branch" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_repo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_pull_request" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'github',
    "repo_id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "merged" BOOLEAN NOT NULL DEFAULT false,
    "head_ref" TEXT NOT NULL,
    "work_item_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_pull_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "github_installation_installation_id_key" ON "github_installation"("installation_id");

-- CreateIndex
CREATE INDEX "github_installation_workspace_id_idx" ON "github_installation"("workspace_id");

-- CreateIndex
CREATE INDEX "github_repo_installation_id_idx" ON "github_repo"("installation_id");

-- CreateIndex
CREATE UNIQUE INDEX "github_repo_installation_id_repo_id_key" ON "github_repo"("installation_id", "repo_id");

-- CreateIndex
CREATE INDEX "github_pull_request_repo_id_idx" ON "github_pull_request"("repo_id");

-- CreateIndex
CREATE INDEX "github_pull_request_work_item_id_idx" ON "github_pull_request"("work_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "github_pull_request_repo_id_number_key" ON "github_pull_request"("repo_id", "number");

-- AddForeignKey
ALTER TABLE "github_installation" ADD CONSTRAINT "github_installation_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_repo" ADD CONSTRAINT "github_repo_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "github_installation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_pull_request" ADD CONSTRAINT "github_pull_request_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "github_repo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_pull_request" ADD CONSTRAINT "github_pull_request_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security — github_installation (workspace gate + system escape)
-- ===========================================================================
-- Grants: the workspace RLS migration's `ALTER DEFAULT PRIVILEGES … TO
-- prodect_app` auto-grants on every NEW table created by the `prodect` role, so
-- none of these three tables needs an explicit GRANT (same as comment / board).
ALTER TABLE "github_installation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "github_installation" FORCE ROW LEVEL SECURITY;

CREATE POLICY "github_installation_workspace_or_system" ON "github_installation"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  );

-- ===========================================================================
-- Row-level security — github_repo (joins through the parent installation)
-- ===========================================================================
ALTER TABLE "github_repo" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "github_repo" FORCE ROW LEVEL SECURITY;

CREATE POLICY "github_repo_workspace_or_system" ON "github_repo"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "github_installation" i
      WHERE i."id" = "github_repo"."installation_id"
        AND i."workspace_id" = current_setting('app.workspace_id', true)
    )
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "github_installation" i
      WHERE i."id" = "github_repo"."installation_id"
        AND i."workspace_id" = current_setting('app.workspace_id', true)
    )
  );

-- ===========================================================================
-- Row-level security — github_pull_request (joins through repo → installation)
-- ===========================================================================
ALTER TABLE "github_pull_request" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "github_pull_request" FORCE ROW LEVEL SECURITY;

CREATE POLICY "github_pull_request_workspace_or_system" ON "github_pull_request"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "github_repo" r
      JOIN "github_installation" i ON i."id" = r."installation_id"
      WHERE r."id" = "github_pull_request"."repo_id"
        AND i."workspace_id" = current_setting('app.workspace_id', true)
    )
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "github_repo" r
      JOIN "github_installation" i ON i."id" = r."installation_id"
      WHERE r."id" = "github_pull_request"."repo_id"
        AND i."workspace_id" = current_setting('app.workspace_id', true)
    )
  );
