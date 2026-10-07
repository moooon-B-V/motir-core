-- CreateEnum
CREATE TYPE "work_item_resume_state" AS ENUM ('waiting_on_gate', 'ready_to_resume');

-- AlterTable
ALTER TABLE "work_item" ADD COLUMN     "resumeState" "work_item_resume_state",
ADD COLUMN     "resume_run_id" TEXT;

-- CreateIndex
CREATE INDEX "work_item_projectId_resumeState_idx" ON "work_item"("projectId", "resumeState");

-- CreateIndex
CREATE INDEX "work_item_resume_run_id_idx" ON "work_item"("resume_run_id");

-- AddForeignKey
ALTER TABLE "work_item" ADD CONSTRAINT "work_item_resume_run_id_fkey" FOREIGN KEY ("resume_run_id") REFERENCES "dispatch_run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

