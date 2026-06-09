-- CreateEnum
CREATE TYPE "estimation_statistic" AS ENUM ('story_points', 'time_estimate', 'issue_count');

-- CreateEnum
CREATE TYPE "point_scale" AS ENUM ('fibonacci', 'linear', 'custom');

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "customScaleValues" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[],
ADD COLUMN     "estimationStatistic" "estimation_statistic" NOT NULL DEFAULT 'story_points',
ADD COLUMN     "pointScale" "point_scale" NOT NULL DEFAULT 'fibonacci';

-- AlterTable
ALTER TABLE "work_item" ADD COLUMN     "storyPoints" DECIMAL(6,2);
