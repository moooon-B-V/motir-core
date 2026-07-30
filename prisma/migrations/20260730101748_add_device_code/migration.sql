-- Device-authorization grants for `motir login` (Story MOTIR-1863 · Subtask
-- MOTIR-1865; decided in docs/decisions/cli-login.md). One row = one in-flight
-- RFC 8628 grant: the terminal opens it, a browser session approves it, and the
-- terminal's next poll exchanges it for a CLI-scoped PAT. 15-minute lifetime,
-- single-use — the row is DELETED the moment it is consumed, denied, or found
-- expired, so this table only ever holds pending state.
--
-- TENANCY DECISION: this table is IDENTITY-SCOPED, NOT WORKSPACE-SCOPED, so it
-- ships with NO RLS — following the `verification` / `email_change_request`
-- precedent rather than the workspace-RLS table contract (the sprint /
-- sprint_report_entry shape: NOT NULL workspace_id + FORCE ROW LEVEL SECURITY +
-- a policy on current_setting('app.workspace_id')). Three reasons, in order of
-- weight:
--
--   1. The row EXISTS BEFORE a workspace is chosen. `workspace_id` is null for
--      most of the grant's life — it is written only at approval, when the human
--      picks which workspace the credential binds to. A NOT NULL tenant
--      discriminator is not available at insert time, so the workspace-scoped
--      contract cannot apply.
--   2. It is READ PRE-AUTH on every poll. `POST /api/cli/device/token` is called
--      by a terminal that holds no session and no bearer — that is the entire
--      point of the flow — so there is no `app.workspace_id` GUC for a policy to
--      gate on. A policy here would hide the row from its only legitimate reader.
--      (Exactly the reason `email_change_request` carries no RLS: the user
--      clicking the confirm link may not have a session either.)
--   3. The CODES ARE the capability. `device_code` (40 chars) and `user_code`
--      (8 chars) are both UNIQUE and are the only keys that reach a row; there is
--      no enumerable id anywhere in the flow. Authorization is the browser
--      approval, not row visibility.
--
-- `workspace_id` is therefore a nullable FK recording the approver's binding
-- CHOICE (which workspace the minted PAT belongs to), not a tenancy column. Both
-- FKs cascade: deleting a user or a workspace drops grants that would mint into
-- them — short-lived auth substrate, not audit (the session / account /
-- email_change_request lifecycle).
--
-- No explicit GRANT is needed: the table is created by the `prodect` role, which
-- already owns the schema (same as verification / email_change_request / api_token).

-- CreateTable
CREATE TABLE "device_code" (
    "id" TEXT NOT NULL,
    "device_code" TEXT NOT NULL,
    "user_code" TEXT NOT NULL,
    "user_id" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "last_polled_at" TIMESTAMP(3),
    "polling_interval" INTEGER,
    "client_id" TEXT,
    "scope" TEXT,
    "workspace_id" TEXT,
    "hostname" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_code_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "device_code_device_code_key" ON "device_code"("device_code");

-- CreateIndex
CREATE UNIQUE INDEX "device_code_user_code_key" ON "device_code"("user_code");

-- CreateIndex
CREATE INDEX "device_code_user_id_idx" ON "device_code"("user_id");

-- CreateIndex
CREATE INDEX "device_code_workspace_id_idx" ON "device_code"("workspace_id");

-- AddForeignKey
ALTER TABLE "device_code" ADD CONSTRAINT "device_code_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_code" ADD CONSTRAINT "device_code_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
