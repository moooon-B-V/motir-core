-- Organization deletion — the request row (Story MOTIR-6306 · Subtask MOTIR-6391).
-- Contract: `docs/decisions/organization-deletion.md` (MOTIR-6389). The org-tier
-- sibling of `account_deletion_request` (20260827200000_add_data_subject_requests),
-- mirrored one for one; read that migration's header for the long form of the two
-- rules below, which are stated here only as far as they differ.
--
-- ADDITIVE AND SAFE ON EXISTING DATA: one table, two enum types and two NULLABLE
-- columns on `organization`. Every existing org reads `closing_since IS NULL` and
-- `erased_at IS NULL`, i.e. live and not closing, which is true of all of them.
--
-- ── THE PARTIAL UNIQUE INDEX IS THE GUARD ON THE FIRST WRITE ───────────────────
-- At most one OPEN request per organization. OPEN is `scheduled` OR `erasing`: a
-- second schedule may not start while the sweep is mid-erasure either (DECISION §1:
-- "a second schedule is refused"). `SELECT … FOR UPDATE` over zero rows locks
-- nothing, so two concurrent Owners' requests both read "none open" and both insert
-- — the index is what rejects the second. The service (MOTIR-6399) catches the
-- resulting `P2002` OUTSIDE its transaction and rethrows its typed error.
--
-- ⚠️ `(organization_id)` must stay the ONLY index on that column alone: Prisma pairs
-- indexes by column list and cannot express `WHERE`, so an `@@index([organizationId])`
-- would be reported as a permanent spurious RENAME (`CLAUDE.md`, the partial-index
-- rule). The history read is `(organization_id, requested_at)`.
--
-- ── THE FK TO `organization` IS `RESTRICT`, ON PURPOSE ──────────────────────────
-- The erasure sweep never deletes the org row (it becomes a tombstone, DECISION §6
-- step 4); only the seven-year purge (MOTIR-6401) does, and it deletes the org's
-- requests first. So a Restrict FK costs nothing on the designed path and turns any
-- OTHER path that would delete an org with a deletion record into a loud error
-- rather than a silently lost record.
--
-- ── ROW-LEVEL SECURITY — the `ci_period_charge` shape ──────────────────────────
-- ORG-scoped: the gate is `organization_id = app.organization_id` (bound by
-- `withOrgContext` / `withOrgServiceWriteContext`), a plain GUC comparison with no
-- per-row subquery. Plus the `system_admin` arm for the two background jobs — the
-- erasure sweep (MOTIR-6400) and the retention purge (MOTIR-6401) — which run with
-- no org bound and WRITE, so the arm is on both `USING` and `WITH CHECK`.
--
-- ONE `FOR ALL` policy with the same predicate on both sides, because Postgres
-- applies the UPDATE policy's `USING` to `SELECT … FOR UPDATE` and filters silently:
-- a split read/update policy returns rows to a plain read and ZERO to the locking
-- read (MOTIR-3707 / MOTIR-3710). `current_setting(…, true)` is missing_ok, so no
-- context means nothing visible.

-- CreateEnum
CREATE TYPE "organization_deletion_status" AS ENUM ('scheduled', 'cancelled', 'erasing', 'erased', 'purged');

-- CreateEnum
CREATE TYPE "organization_erasure_step" AS ENUM ('git', 'workspaces', 'ai', 'tombstone');

-- AlterTable
ALTER TABLE "organization" ADD COLUMN     "closing_since" TIMESTAMP(3),
ADD COLUMN     "erased_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "organization_deletion_request" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "requested_by_user_id" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "erasure_due_at" TIMESTAMP(3) NOT NULL,
    "status" "organization_deletion_status" NOT NULL DEFAULT 'scheduled',
    "cancelled_at" TIMESTAMP(3),
    "cancelled_by_user_id" TEXT,
    "erasing_started_at" TIMESTAMP(3),
    "erased_at" TIMESTAMP(3),
    "purged_at" TIMESTAMP(3),
    "erasure_step" "organization_erasure_step",
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_deletion_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "organization_deletion_request_organization_id_requested_at_idx" ON "organization_deletion_request"("organization_id", "requested_at");

-- CreateIndex
CREATE INDEX "organization_deletion_request_status_erasure_due_at_idx" ON "organization_deletion_request"("status", "erasure_due_at");

-- CreateIndex
CREATE INDEX "organization_deletion_request_requested_by_user_id_idx" ON "organization_deletion_request"("requested_by_user_id");

-- CreateIndex
CREATE INDEX "organization_deletion_request_cancelled_by_user_id_idx" ON "organization_deletion_request"("cancelled_by_user_id");

-- AddForeignKey
ALTER TABLE "organization_deletion_request" ADD CONSTRAINT "organization_deletion_request_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_deletion_request" ADD CONSTRAINT "organization_deletion_request_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_deletion_request" ADD CONSTRAINT "organization_deletion_request_cancelled_by_user_id_fkey" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- CreateIndex
-- At most one OPEN request per organization — see the header.
CREATE UNIQUE INDEX "organization_deletion_request_open_per_org_key"
  ON "organization_deletion_request"("organization_id")
  WHERE "status" IN ('scheduled', 'erasing');

-- ===========================================================================
-- Row-level security — organization_deletion_request
-- ===========================================================================
ALTER TABLE "organization_deletion_request" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_deletion_request" FORCE ROW LEVEL SECURITY;

CREATE POLICY "organization_deletion_request_org_or_system" ON "organization_deletion_request"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "organization_id" = current_setting('app.organization_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "organization_id" = current_setting('app.organization_id', true)
  );
