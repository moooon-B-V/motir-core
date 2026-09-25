-- MOTIR-5544 · MOTIR-6282 — the run-found report's record.
--
-- `docs/decisions/run-found-trigger-dispatched-path.md` names two pieces of
-- storage the `report_unbuildable_target` endpoint needs, and this migration
-- ships both and nothing that decides anything:
--
--   1. `run_found_report` — the FILING ROW. One per stopped leg, unique on the
--      `dispatch_run_card` id, inserted and locked before a planning bug is
--      filed so a retried report files at most one. The
--      `job_dlq_standing_filing` pattern (MOTIR-5869), mirrored.
--   2. `dispatch_event_kind.unbuildable_reported` — the CARD-scoped finding the
--      report service appends to the leg on every arm. Server-written only; the
--      v1 ingest refuses it.

-- CreateEnum
CREATE TYPE "run_found_report_outcome" AS ENUM ('no_plan', 'not_native', 'changed', 'filed');

-- AlterEnum — the shape of `20260830140000_dispatch_run_findings`. `IF NOT
-- EXISTS` makes a re-applied migration a no-op; nothing orders events by kind.
ALTER TYPE "dispatch_event_kind" ADD VALUE IF NOT EXISTS 'unbuildable_reported';

-- CreateTable
CREATE TABLE "run_found_report" (
    "id" TEXT NOT NULL,
    "dispatch_run_card_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "outcome" "run_found_report_outcome",
    "filed_work_item_id" TEXT,
    "filed_work_item_identifier" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "run_found_report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "run_found_report_dispatch_run_card_id_key" ON "run_found_report"("dispatch_run_card_id");

-- AddForeignKey — a deleted leg takes its report with it.
ALTER TABLE "run_found_report" ADD CONSTRAINT "run_found_report_dispatch_run_card_id_fkey" FOREIGN KEY ("dispatch_run_card_id") REFERENCES "dispatch_run_card"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security — SYSTEM-ADMIN ONLY
-- ===========================================================================
-- DELIBERATELY not the tenant-table default. The row is MOTIR's record of what
-- it filed into its own project: it carries a key in Motir's meta project and
-- nothing the tenant reads. `workspace_id` records the leg's tenant and is not a
-- policy arm. The report service is its only reader and writer, under
-- `withSystemContext` — copied from `job_dlq_standing_filing`.
ALTER TABLE "run_found_report" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "run_found_report" FORCE ROW LEVEL SECURITY;

CREATE POLICY "run_found_report_system_admin" ON "run_found_report"
  FOR ALL
  USING (current_setting('app.system_admin', true) = 'true')
  WITH CHECK (current_setting('app.system_admin', true) = 'true');
