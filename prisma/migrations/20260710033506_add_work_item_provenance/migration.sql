-- CreateEnum
CREATE TYPE "work_item_planning_source" AS ENUM ('native', 'mcp', 'manual');

-- CreateEnum
CREATE TYPE "work_item_implementation_source" AS ENUM ('hosted', 'byok', 'manual');

-- AlterTable
ALTER TABLE "work_item" ADD COLUMN     "implementationHarness" TEXT,
ADD COLUMN     "implementationModel" TEXT,
ADD COLUMN     "implementationSource" "work_item_implementation_source",
ADD COLUMN     "planningHarness" TEXT,
ADD COLUMN     "planningModel" TEXT,
ADD COLUMN     "planningSource" "work_item_planning_source";

