-- AlterTable
ALTER TABLE "api_token" ADD COLUMN     "project_id" TEXT;

-- CreateIndex
CREATE INDEX "api_token_project_id_idx" ON "api_token"("project_id");

-- AddForeignKey
ALTER TABLE "api_token" ADD CONSTRAINT "api_token_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
