-- AlterTable
ALTER TABLE "project" ADD COLUMN     "ai_auto_plan_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ai_auto_plan_threshold" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "ai_planner_model" TEXT,
ADD COLUMN     "ai_sprint_length_days" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "ai_sprint_planning_enabled" BOOLEAN NOT NULL DEFAULT false;
