-- Enterprise requests — the record behind the Enterprise card's Contact sales
-- control (Story MOTIR-7602 · Subtask MOTIR-7605). An org owner or admin sends
-- one from Billing & plans; platform staff work it in the operator console's
-- Enterprise requests page (MOTIR-7608 / MOTIR-7609).
--
-- ADDITIVE AND SAFE ON EXISTING DATA: one new table and five new enum types;
-- nothing existing is altered and the table starts empty.
--
-- ── THE PARTIAL UNIQUE INDEX IS THE GUARD ──────────────────────────────────
-- "At most one OPEN request per org" lives HERE, not in application code. A
-- check-then-insert lets two tabs both read "nothing open" and both insert, and
-- `SELECT … FOR UPDATE` over zero rows locks nothing. The index raises a raw
-- `P2002`; `enterpriseRequestService.create` translates it into the typed
-- `ENTERPRISE_REQUEST_OPEN` refusal carrying the open request's id. `won` and
-- `lost` are terminal history, so an org may hold any number of them and may
-- ask again once its request is closed.
--
-- Its column list `(organization_id)` is shared with no `@@index` on the model —
-- the history read is `(organization_id, created_at)` — so Prisma's differ never
-- pairs it with a datamodel index (`CLAUDE.md`, the partial-index rule).
--
-- ── ROW-LEVEL SECURITY ─────────────────────────────────────────────────────
-- Two policies, each `FOR ALL` with the same predicate on both sides (a split
-- read / update pair makes `FOR UPDATE` silently return zero rows, MOTIR-3710):
--   * `enterprise_request_org_or_system` — the org's own reads and its create,
--     under `withOrgContext` (`app.organization_id`), and the staff email job,
--     which reads the request back under `withSystemContext` after it commits.
--   * `enterprise_request_platform_staff` — the console's cross-tenant list and
--     its state changes, under `withPlatformRead` (`app.platform_staff`, never
--     the system GUC: `platform-staff-auth.md` §3a).
-- An unset GUC yields NULL and hides the row — no context, nothing visible.

-- CreateEnum
CREATE TYPE "enterprise_request_status" AS ENUM ('new', 'contacted', 'offer_sent', 'won', 'lost');

-- CreateEnum
CREATE TYPE "enterprise_agent_path" AS ENUM ('hosted', 'own', 'both');

-- CreateEnum
CREATE TYPE "enterprise_autonomy" AS ENUM ('autonomous_lead', 'volume_only', 'unsure');

-- CreateEnum
CREATE TYPE "enterprise_start_when" AS ENUM ('now', 'within_month', 'within_quarter', 'exploring');

-- CreateEnum
CREATE TYPE "enterprise_team_size" AS ENUM ('size_1_10', 'size_11_50', 'size_51_200', 'size_201_plus');

-- CreateTable
CREATE TABLE "enterprise_request" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "requested_by_id" TEXT,
    "status" "enterprise_request_status" NOT NULL DEFAULT 'new',
    "cards_per_day" INTEGER,
    "parallel_agents" INTEGER,
    "agent_path" "enterprise_agent_path",
    "autonomy" "enterprise_autonomy",
    "start_when" "enterprise_start_when",
    "team_size" "enterprise_team_size",
    "contact" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "tier_key_at_request" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "enterprise_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "enterprise_request_status_created_at_idx" ON "enterprise_request"("status", "created_at");

-- CreateIndex
CREATE INDEX "enterprise_request_organization_id_created_at_idx" ON "enterprise_request"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "enterprise_request_requested_by_id_idx" ON "enterprise_request"("requested_by_id");

-- AddForeignKey
ALTER TABLE "enterprise_request" ADD CONSTRAINT "enterprise_request_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enterprise_request" ADD CONSTRAINT "enterprise_request_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- CreateIndex
-- At most one OPEN request per org — see the header for why this, and not a
-- lock, is what makes the create race-safe.
CREATE UNIQUE INDEX "enterprise_request_open_per_org_key"
  ON "enterprise_request"("organization_id")
  WHERE "status" IN ('new', 'contacted', 'offer_sent');

-- ===========================================================================
-- Row-level security — enterprise_request
-- ===========================================================================
ALTER TABLE "enterprise_request" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "enterprise_request" FORCE ROW LEVEL SECURITY;

CREATE POLICY "enterprise_request_org_or_system" ON "enterprise_request"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "organization_id" = current_setting('app.organization_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "organization_id" = current_setting('app.organization_id', true)
  );

CREATE POLICY "enterprise_request_platform_staff" ON "enterprise_request"
  FOR ALL
  USING      (coalesce(current_setting('app.platform_staff', true), '') = 'true')
  WITH CHECK (coalesce(current_setting('app.platform_staff', true), '') = 'true');
