-- CreateTable
CREATE TABLE "ci_period_charge" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "accounted_minutes" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "charged_minutes" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "charged_credits" INTEGER NOT NULL DEFAULT 0,
    "debited_credits" INTEGER NOT NULL DEFAULT 0,
    "pending_debit_ref" TEXT,
    "pending_debit_credits" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ci_period_charge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ci_period_charge_organization_id_period_start_key" ON "ci_period_charge"("organization_id", "period_start");

-- AddForeignKey
ALTER TABLE "ci_period_charge" ADD CONSTRAINT "ci_period_charge_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security — shipped in the SAME migration as the table, so there is
-- never an unguarded window (PRODECT_FINDINGS #20). ENABLE + FORCE so even the
-- table-owner `prodect` role is subject to it (production and the service writes
-- connect as the non-BYPASSRLS `prodect_app` role).
--
-- ⚠️ This gate is on `app.organization_id`, NOT `app.workspace_id` — the one
-- place this table deliberately departs from its two metering siblings
-- (`ci_workflow_run_usage` / `ci_period_usage`, which are workspace-scoped). The
-- pool and the credit ledger are both ORG-level (`ci-minutes-allowance.md` §4.1),
-- so a charge spanning an org's workspaces has no single workspace to gate on;
-- gating it on one would make the row invisible from the org's other workspaces.
-- This mirrors the shipped `organization` / `organization_membership` policies,
-- which key off the same GUC (`withOrgContext` / `withOrgServiceWriteContext`).
--
-- It ALSO carries the `app.system_admin` escape, for the same reason the meter's
-- tables do: the charger runs from the GitHub `workflow_run` WEBHOOK, which has
-- no session, no active workspace and no active org, and therefore writes under
-- `withSystemContext`. Without the hatch the entitlement could not record what it
-- charged. The read path used by the billing panel (MOTIR-1903) binds a real
-- `app.organization_id` instead and so sees exactly its own org's row.
--
-- The workspace RLS migration's `ALTER DEFAULT PRIVILEGES … TO prodect_app`
-- auto-grants on every NEW table created by the `prodect` role, so no explicit
-- GRANT is needed.
ALTER TABLE "ci_period_charge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ci_period_charge" FORCE ROW LEVEL SECURITY;

CREATE POLICY "ci_period_charge_org_or_system" ON "ci_period_charge"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "organization_id" = current_setting('app.organization_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "organization_id" = current_setting('app.organization_id', true)
  );
