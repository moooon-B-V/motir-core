-- AlterTable
ALTER TABLE "work_item" ADD COLUMN     "externalSubmitterEmail" TEXT,
ADD COLUMN     "externalSubmitterName" TEXT,
ADD COLUMN     "snoozedUntil" TIMESTAMP(3),
ADD COLUMN     "triagedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "work_item_projectId_triagedAt_idx" ON "work_item"("projectId", "triagedAt");
