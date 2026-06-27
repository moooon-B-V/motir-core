-- CreateEnum
CREATE TYPE "work_item_link_source" AS ENUM ('manual', 'mention');

-- AlterTable
ALTER TABLE "work_item_link" ADD COLUMN     "source" "work_item_link_source" NOT NULL DEFAULT 'manual';
