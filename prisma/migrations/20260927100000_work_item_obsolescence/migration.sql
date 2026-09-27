-- CreateEnum
CREATE TYPE "work_item_obsolescence" AS ENUM ('outdated', 'deprecated');

-- AlterTable
ALTER TABLE "work_item" ADD COLUMN     "obsolescence" "work_item_obsolescence",
ADD COLUMN     "obsolescenceNoteMd" TEXT;
