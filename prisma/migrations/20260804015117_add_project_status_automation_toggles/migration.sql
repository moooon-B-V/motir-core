-- AlterTable
ALTER TABLE "project" ADD COLUMN     "auto_complete_children_on_parent_done" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "auto_rollup_parent_status" BOOLEAN NOT NULL DEFAULT true;
