-- CreateEnum
CREATE TYPE "work_item_difficulty" AS ENUM ('low', 'medium', 'high');

-- AlterTable
ALTER TABLE "work_item" ADD COLUMN     "difficulty" "work_item_difficulty";
