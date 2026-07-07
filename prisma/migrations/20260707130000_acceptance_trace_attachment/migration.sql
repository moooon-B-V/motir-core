-- AlterEnum: the Playwright trace is now a first-class private attachment (MOTIR-1674).
ALTER TYPE "attachment_source" ADD VALUE 'acceptance_trace';

-- AlterTable: replace the raw trace_url pathname with a trace_attachment_id FK.
-- No backfill — the private store has 0 acceptance rows in production.
ALTER TABLE "acceptance_evidence" DROP COLUMN "trace_url";
ALTER TABLE "acceptance_evidence" ADD COLUMN "trace_attachment_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "acceptance_evidence_trace_attachment_id_key" ON "acceptance_evidence"("trace_attachment_id");

-- AddForeignKey
ALTER TABLE "acceptance_evidence" ADD CONSTRAINT "acceptance_evidence_trace_attachment_id_fkey" FOREIGN KEY ("trace_attachment_id") REFERENCES "attachment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
