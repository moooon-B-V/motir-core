-- Story MOTIR-6577 · MOTIR-6630: an `add` proposal carries the OLDER work items
-- the created card supersedes. Additive: every existing plan item reads `{}`.

-- AlterTable
ALTER TABLE "plan_item" ADD COLUMN     "supersedes_refs" TEXT[] DEFAULT ARRAY[]::TEXT[];
