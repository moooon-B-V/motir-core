-- AlterTable
ALTER TABLE "plan_change_turn" ADD COLUMN     "attachment_ids" TEXT[] DEFAULT ARRAY[]::TEXT[];
