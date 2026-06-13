-- CreateEnum
CREATE TYPE "work_item_type" AS ENUM ('code', 'design', 'test', 'content', 'research', 'review', 'decision', 'deploy', 'manual', 'chore');

-- CreateEnum
CREATE TYPE "executor" AS ENUM ('coding_agent', 'human');

-- AlterTable
ALTER TABLE "work_item" ADD COLUMN     "executor" "executor",
ADD COLUMN     "type" "work_item_type";
