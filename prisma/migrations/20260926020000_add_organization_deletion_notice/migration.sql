-- Organization-deletion emails — the notice dedupe record (Story MOTIR-6306 ·
-- MOTIR-6395). Contract: `docs/decisions/organization-deletion.md` §8.
--
-- ADDITIVE: one table and one enum. Each row records that one notice (scheduled,
-- cancelled, a 7- or 1-day reminder, erased) went out for one request, so a
-- re-run of the daily reminder job or a retried caller sends nothing twice. The
-- unique `(request_id, kind, days_left)` is the guard.
--
-- RLS: SYSTEM ONLY. Every reader and writer is the notifier, which runs its
-- bookkeeping under `withSystemContext` (the reminder job has no user and no
-- org; the schedule / cancel callers hand it a request id after their own commit).
-- No tenant surface reads it, so there is no tenant arm to get wrong.

-- CreateEnum
CREATE TYPE "organization_deletion_notice_kind" AS ENUM ('scheduled', 'cancelled', 'reminder', 'erased');

-- CreateTable
CREATE TABLE "organization_deletion_notice" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "kind" "organization_deletion_notice_kind" NOT NULL,
    "days_left" INTEGER NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_deletion_notice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organization_deletion_notice_request_id_kind_days_left_key" ON "organization_deletion_notice"("request_id", "kind", "days_left");

-- AddForeignKey
ALTER TABLE "organization_deletion_notice" ADD CONSTRAINT "organization_deletion_notice_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "organization_deletion_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- Row-level security — organization_deletion_notice
-- ===========================================================================
ALTER TABLE "organization_deletion_notice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_deletion_notice" FORCE ROW LEVEL SECURITY;

CREATE POLICY "organization_deletion_notice_system" ON "organization_deletion_notice"
  FOR ALL
  USING (current_setting('app.system_admin', true) = 'true')
  WITH CHECK (current_setting('app.system_admin', true) = 'true');
