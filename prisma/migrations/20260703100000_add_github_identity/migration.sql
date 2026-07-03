-- CreateTable
CREATE TABLE "github_identity" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "github_user_id" TEXT NOT NULL,
    "github_login" TEXT NOT NULL,
    "avatar_url" TEXT,
    "access_token_encrypted" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_identity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "github_identity_user_id_key" ON "github_identity"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "github_identity_github_user_id_key" ON "github_identity"("github_user_id");

-- CreateIndex
CREATE INDEX "github_identity_user_id_idx" ON "github_identity"("user_id");

-- AddForeignKey
ALTER TABLE "github_identity" ADD CONSTRAINT "github_identity_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security — github_identity (Story 7.10 · MOTIR-1498)
-- ===========================================================================
-- A GitHub OAuth identity is per-USER, not per-workspace, so the gate keys on
-- the `app.user_id` GUC (the api_token precedent) rather than
-- `app.workspace_id`: the OAuth start/callback flow and the settings read run
-- under `withUserContext`, so a member sees/mutates ONLY their own identity.
--
-- The system-admin branch mirrors api_token's escape for pre-user-context
-- paths (`withSystemContext` binds `app.system_admin` to a constant, never user
-- input). USING governs the owner SELECT; WITH CHECK lets the callback's
-- upsert INSERT/UPDATE land under the non-bypass prodect_app role.
ALTER TABLE "github_identity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "github_identity" FORCE ROW LEVEL SECURITY;
CREATE POLICY "github_identity_owner_or_system" ON "github_identity"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "user_id" = current_setting('app.user_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "user_id" = current_setting('app.user_id', true)
  );
