-- CreateTable
CREATE TABLE "import_source_identity" (
    "id" TEXT NOT NULL,
    "source" "import_source" NOT NULL,
    "user_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "access_token_encrypted" TEXT NOT NULL,
    "refresh_token_encrypted" TEXT,
    "expires_at" TIMESTAMP(3),
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_source_identity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_source_identity_user_id_idx" ON "import_source_identity"("user_id");

-- CreateIndex
CREATE INDEX "import_source_identity_workspace_id_idx" ON "import_source_identity"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "import_source_identity_user_id_source_workspace_id_key" ON "import_source_identity"("user_id", "source", "workspace_id");

-- AddForeignKey
ALTER TABLE "import_source_identity" ADD CONSTRAINT "import_source_identity_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_source_identity" ADD CONSTRAINT "import_source_identity_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security — import_source_identity (Story 7.16 · MOTIR-1653)
-- ===========================================================================
-- An import-source OAuth identity is per-USER (it holds that member's vendor
-- tokens), so the gate keys on the `app.user_id` GUC — the GithubIdentity /
-- api_token precedent — NOT `app.workspace_id`, even though the row also carries
-- a `workspace_id` scope column: the connect callback + the connector's
-- fetch-and-decrypt read run under `withUserContext`, so a member sees/mutates
-- ONLY their own identities.
--
-- The system-admin branch mirrors github_identity's escape for pre-user-context
-- paths (`withSystemContext` binds `app.system_admin` to a constant, never user
-- input). USING governs the owner SELECT; WITH CHECK lets the callback's upsert
-- INSERT/UPDATE land under the non-bypass prodect_app role.
ALTER TABLE "import_source_identity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_source_identity" FORCE ROW LEVEL SECURITY;
CREATE POLICY "import_source_identity_owner_or_system" ON "import_source_identity"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "user_id" = current_setting('app.user_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "user_id" = current_setting('app.user_id', true)
  );
