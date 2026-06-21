-- AlterTable
ALTER TABLE "user" ADD COLUMN     "lastActiveProjectId" TEXT;

-- CreateIndex
CREATE INDEX "user_lastActiveProjectId_idx" ON "user"("lastActiveProjectId");

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_lastActiveProjectId_fkey" FOREIGN KEY ("lastActiveProjectId") REFERENCES "project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
