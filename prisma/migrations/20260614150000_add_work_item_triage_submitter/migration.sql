-- AlterTable
ALTER TABLE "work_item" ADD COLUMN     "submittedByUserId" TEXT;

-- AddForeignKey
ALTER TABLE "work_item" ADD CONSTRAINT "work_item_submittedByUserId_fkey" FOREIGN KEY ("submittedByUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
