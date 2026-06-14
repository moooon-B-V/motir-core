-- AlterTable
ALTER TABLE "work_item" ADD COLUMN     "publicChildrenHidden" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "work_item_projectId_publicChildrenHidden_idx" ON "work_item"("projectId", "publicChildrenHidden");
