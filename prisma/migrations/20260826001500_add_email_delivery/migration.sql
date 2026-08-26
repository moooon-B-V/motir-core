-- The transactional-mail DELIVERY record (Bug MOTIR-3507 · Subtask MOTIR-3513),
-- with its RLS policy IN THIS SAME MIGRATION — the "table + its policy in one
-- migration, no unguarded window" invariant (PRODECT_FINDINGS #20).
--
-- ===========================================================================
-- What this table is for
-- ===========================================================================
-- `job_run` records whether the SEND succeeded, and for a real provider that
-- means one thing only: the provider accepted the POST. It says nothing about
-- whether the message was delivered. A `succeeded` run next to a bounced
-- invitation is exactly what hid MOTIR-3507 — a workspace invitation sat in a
-- NetEase spam folder for a day and was found by a person opening the folder,
-- because nothing in the system could have reported it.
--
-- This table is the other half. One row per ACCEPTED message, keyed on the
-- provider's own id, so the delivery events the provider already emits
-- (`email.delivered`, `email.bounced`, `email.complained`,
-- `email.delivery_delayed`) have somewhere to land. The webhook that writes
-- them is MOTIR-3515; this migration only creates the record and seeds it at
-- `accepted`.
--
-- ===========================================================================
-- Why `workspace_id` is NULLABLE, and what that means for RLS
-- ===========================================================================
-- `email.send` is the one job whose payload permits a null workspace: a
-- password reset is not owned by a workspace. `job_event.workspace_id` is
-- nullable for the same reason and is guarded the same way — the policy below
-- is the `system_admin OR workspace_id` shape every job table already uses.
--
-- The consequence is deliberate: an untenanted row is reachable ONLY through
-- the system-admin branch, which is the context the job runtime writes under
-- (`withSystemContext`). A workspace member reading the operator dashboard
-- sees their own workspace's deliveries and nothing else — the untenanted
-- password-reset rows are invisible to every tenant, which is correct, since
-- the recipient of a password reset is not the workspace's business.
--
-- ===========================================================================
-- Why `provider_message_id` is UNIQUE and nullable
-- ===========================================================================
-- UNIQUE so a retried job attempt the provider deduped to the SAME message
-- cannot write a second row. NULLABLE because the dev providers ('console',
-- 'file') issue no id, and a real 2xx whose body does not parse is still a
-- message the provider has accepted (see `EmailSendResult` in lib/email.ts).
-- Postgres admits many NULLs under a unique index, which is the wanted
-- behaviour: every id-less send gets its own row, and every id'd send is
-- deduped.

-- CreateEnum
CREATE TYPE "email_delivery_state" AS ENUM ('accepted', 'delivered', 'bounced', 'complained', 'delayed');

-- CreateTable
CREATE TABLE "email_delivery" (
    "id" TEXT NOT NULL,
    "provider_message_id" TEXT,
    "provider" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "workspace_id" TEXT,
    "state" "email_delivery_state" NOT NULL DEFAULT 'accepted',
    "idempotency_key" TEXT,
    "run_id" TEXT,
    "event_id" TEXT,
    "last_event_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_delivery_provider_message_id_key" ON "email_delivery"("provider_message_id");

-- CreateIndex
CREATE INDEX "email_delivery_workspace_id_created_at_idx" ON "email_delivery"("workspace_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "email_delivery_idempotency_key_idx" ON "email_delivery"("idempotency_key");

-- CreateIndex
CREATE INDEX "email_delivery_run_id_idx" ON "email_delivery"("run_id");

-- AddForeignKey
ALTER TABLE "email_delivery" ADD CONSTRAINT "email_delivery_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security — email_delivery
-- ===========================================================================
ALTER TABLE "email_delivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_delivery" FORCE ROW LEVEL SECURITY;

-- email_delivery: a tenant sees its own workspace's deliveries; the trusted
-- writer (the email.send job, and the delivery webhook that updates these rows
-- in MOTIR-3515) reaches every row — including the untenanted ones — through
-- the system-admin branch. USING governs the tenant SELECT; WITH CHECK lets the
-- job's INSERT and the webhook's UPDATE land under the non-bypass role.
CREATE POLICY "email_delivery_workspace_or_system_admin" ON "email_delivery"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  );
