-- CreateTable
CREATE TABLE "github_agent_authorization" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "github_user_id" TEXT NOT NULL,
    "github_login" TEXT NOT NULL,
    "access_token_encrypted" TEXT NOT NULL,
    "access_token_expires_at" TIMESTAMP(3),
    "refresh_token_encrypted" TEXT,
    "refresh_token_expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_agent_authorization_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "github_agent_authorization_user_id_key" ON "github_agent_authorization"("user_id");

-- AddForeignKey
ALTER TABLE "github_agent_authorization" ADD CONSTRAINT "github_agent_authorization_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security — github_agent_authorization (Story MOTIR-683 · MOTIR-6519)
-- ===========================================================================
-- Per-USER, exactly as `github_identity` (MOTIR-1498): the link / unlink routes
-- and the token read run under `withUserContext`, so a member sees and mutates
-- ONLY their own authorization. The system-admin branch is the same constant
-- escape `api_token` / `github_identity` carry. There is deliberately NO member
-- read arm: nothing reads another member's Motir Agent authorization.
ALTER TABLE "github_agent_authorization" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "github_agent_authorization" FORCE ROW LEVEL SECURITY;
CREATE POLICY "github_agent_authorization_owner_or_system" ON "github_agent_authorization"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "user_id" = current_setting('app.user_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "user_id" = current_setting('app.user_id', true)
  );
