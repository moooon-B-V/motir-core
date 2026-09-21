-- The DLQ STANDING-DEPTH filer's dedup row (MOTIR-5869). One row per job
-- function whose standing dead letters have been filed as a bug; `armed` is what
-- stops a re-file until that function's standing depth returns to zero.
-- `docs/decisions/dead-letter-standing-depth-filing.md` is the decision.

-- CreateTable
CREATE TABLE "job_dlq_standing_filing" (
    "id" TEXT NOT NULL,
    "function_id" TEXT NOT NULL,
    "armed" BOOLEAN NOT NULL DEFAULT true,
    "filed_work_item_identifier" TEXT,
    "filed_at" TIMESTAMP(3),
    "rearmed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_dlq_standing_filing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "job_dlq_standing_filing_function_id_key" ON "job_dlq_standing_filing"("function_id");

-- ===========================================================================
-- Row-level security — SYSTEM-ADMIN ONLY
-- ===========================================================================
-- Deployment-wide and untenanted, like `job_run_dlq` (whose `system.*` rows
-- carry no workspace): there is no workspace column for a tenant arm to compare.
-- The sweep is its only reader and writer, under `withSystemContext`.
ALTER TABLE "job_dlq_standing_filing" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job_dlq_standing_filing" FORCE ROW LEVEL SECURITY;

CREATE POLICY "job_dlq_standing_filing_system_admin" ON "job_dlq_standing_filing"
  FOR ALL
  USING (current_setting('app.system_admin', true) = 'true')
  WITH CHECK (current_setting('app.system_admin', true) = 'true');
