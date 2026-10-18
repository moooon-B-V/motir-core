-- AlterTable
ALTER TABLE "work_item" ADD COLUMN     "embedding_failed_hash" TEXT,
ADD COLUMN     "embedding_failed_attempts" INTEGER;
