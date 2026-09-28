-- MOTIR-6449: the GitHub installation tokens handed to a hosted run
-- (`docs/decisions/hosted-run-runs-the-cli-as-the-app.md` §5), recorded so the end
-- path can revoke every one. The token is stored encrypted; the rows are deleted
-- once revoked.

-- CreateTable
CREATE TABLE "dispatch_run_git_credential" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "dispatch_run_id" TEXT NOT NULL,
    "app" TEXT NOT NULL,
    "installation_id" TEXT NOT NULL,
    "repositories" TEXT[],
    "token_encrypted" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispatch_run_git_credential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dispatch_run_git_credential_dispatch_run_id_idx" ON "dispatch_run_git_credential"("dispatch_run_id");

-- CreateIndex
CREATE INDEX "dispatch_run_git_credential_workspace_id_idx" ON "dispatch_run_git_credential"("workspace_id");

-- AddForeignKey
ALTER TABLE "dispatch_run_git_credential" ADD CONSTRAINT "dispatch_run_git_credential_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_run_git_credential" ADD CONSTRAINT "dispatch_run_git_credential_dispatch_run_id_fkey" FOREIGN KEY ("dispatch_run_id") REFERENCES "dispatch_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS, in the same migration as the table (no unguarded window), exactly as
-- `dispatch_run_card`: FORCE so the table-owner role is subject to it, and the
-- gate is the row's OWN `workspace_id` (RLS does not traverse the FK to the run).
-- The default privileges grant `prodect_app` on every new table, so no GRANT.
ALTER TABLE "dispatch_run_git_credential" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dispatch_run_git_credential" FORCE ROW LEVEL SECURITY;

CREATE POLICY "dispatch_run_git_credential_active_workspace" ON "dispatch_run_git_credential"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
