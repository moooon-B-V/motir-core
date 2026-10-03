-- Staff "View as" sessions (Story 10.3 · MOTIR-749).
--
-- One row per impersonation session a platform superadmin opens: who, as whom,
-- in which organization / workspace, read-only or full, why, and the time-box.
-- The row is OPERATIONAL state — the gate reads it on every request of the
-- session; the permanent record is the hash-chained `platform_audit_log`
-- (`user.impersonation_start` / `_view` / `_action` / `_end`). ADDITIVE: no
-- existing row changes.
--
-- The cookie carries a random token; only its SHA-256 is stored (`token_hash`).
-- `operator_session_id` is deliberately NOT a foreign key: signing out deletes
-- the Better-Auth session row, and this row must outlive it so its end can
-- still be recorded (a mismatch revokes the staff session at the gate).
--
-- ── ROW-LEVEL SECURITY ─────────────────────────────────────────────────────
-- No TENANT arm, by design: a customer never reads or writes these rows.
--   · `app.platform_staff` — started, ended and listed inside `withPlatformRead`,
--     which appends the audit row in the same transaction.
--   · `app.system_admin` — the request-path gate resolves the cookie's session
--     under `withSystemContext` before any identity is known. READ only: it is
--     not on `WITH CHECK`, so no system path can open or end a session.
-- ONE `FOR ALL` policy, because Postgres applies the UPDATE policy's `USING` to
-- `SELECT … FOR UPDATE` (MOTIR-3707 / MOTIR-3710), as `org_feature_flag` does.
-- CreateEnum
CREATE TYPE "impersonation_mode" AS ENUM ('read_only', 'full');

-- CreateEnum
CREATE TYPE "impersonation_ended_by" AS ENUM ('operator', 'expiry', 'revoked');

-- CreateTable
CREATE TABLE "impersonation_session" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "operator_user_id" TEXT NOT NULL,
    "operator_role" "platform_role" NOT NULL,
    "operator_session_id" TEXT NOT NULL,
    "target_user_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "mode" "impersonation_mode" NOT NULL,
    "reason" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "ended_by" "impersonation_ended_by",

    CONSTRAINT "impersonation_session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "impersonation_session_token_hash_key" ON "impersonation_session"("token_hash");

-- CreateIndex
CREATE INDEX "impersonation_session_operator_user_id_ended_at_idx" ON "impersonation_session"("operator_user_id", "ended_at");

-- CreateIndex
CREATE INDEX "impersonation_session_target_user_id_idx" ON "impersonation_session"("target_user_id");

-- CreateIndex
CREATE INDEX "impersonation_session_organization_id_idx" ON "impersonation_session"("organization_id");

-- CreateIndex
CREATE INDEX "impersonation_session_workspace_id_idx" ON "impersonation_session"("workspace_id");

-- CreateIndex
CREATE INDEX "impersonation_session_ended_at_expires_at_idx" ON "impersonation_session"("ended_at", "expires_at");

-- AddForeignKey
ALTER TABLE "impersonation_session" ADD CONSTRAINT "impersonation_session_operator_user_id_fkey" FOREIGN KEY ("operator_user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "impersonation_session" ADD CONSTRAINT "impersonation_session_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "impersonation_session" ADD CONSTRAINT "impersonation_session_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "impersonation_session" ADD CONSTRAINT "impersonation_session_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- Row-level security — impersonation_session
-- ===========================================================================
ALTER TABLE "impersonation_session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "impersonation_session" FORCE ROW LEVEL SECURITY;

CREATE POLICY "impersonation_session_platform_or_system" ON "impersonation_session"
  FOR ALL
  USING (
    coalesce(current_setting('app.platform_staff', true), '') = 'true'
    OR current_setting('app.system_admin', true) = 'true'
  )
  WITH CHECK (
    coalesce(current_setting('app.platform_staff', true), '') = 'true'
  );
