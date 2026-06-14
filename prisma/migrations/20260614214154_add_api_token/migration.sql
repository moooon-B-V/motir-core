-- CreateTable
CREATE TABLE "api_token" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "token_prefix" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_token_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_token_token_hash_key" ON "api_token"("token_hash");

-- CreateIndex
CREATE INDEX "api_token_user_id_idx" ON "api_token"("user_id");

-- AddForeignKey
ALTER TABLE "api_token" ADD CONSTRAINT "api_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security — api_token (Story 7.8 · Subtask 7.8.1)
-- ===========================================================================
-- A personal access token is per-USER, not per-workspace, so the gate keys on
-- the `app.user_id` GUC (the workspace_membership precedent) rather than
-- `app.workspace_id`: the settings surface (create / list / revoke) runs under
-- `withUserContext`, so a user sees/mutates ONLY their own tokens.
--
-- The system-admin branch is the deliberate escape for the MCP bearer gate:
-- `apiTokensService.verify` resolves a presented token to its owning user
-- BEFORE any user context exists (the pre-auth lookup), so it cannot bind
-- `app.user_id` — it runs under `withSystemContext` (binding `app.system_admin`
-- to a constant, never user input, the job-ledger precedent). USING governs the
-- owner SELECT; WITH CHECK lets the create/revoke INSERT/UPDATE — and verify's
-- throttled `last_used_at` touch — land under the non-bypass prodect_app role.
ALTER TABLE "api_token" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "api_token" FORCE ROW LEVEL SECURITY;

CREATE POLICY "api_token_owner_or_system" ON "api_token"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "user_id" = current_setting('app.user_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "user_id" = current_setting('app.user_id', true)
  );
