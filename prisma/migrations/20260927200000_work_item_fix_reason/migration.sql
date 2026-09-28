-- Story MOTIR-6588 · MOTIR-6600 — WHY a card is stuck until something is repaired.
--
-- Two nullable columns on `work_item`, written only by
-- `fixReasonService.recomputeWorkItemFixReason` (under the card's row lock) and
-- backfilled once by `pnpm db:backfill:fix-reason` (MOTIR-6603). Additive: every
-- existing row reads NULL, which is "nothing to repair" until the backfill runs.
--
-- The index serves the Workbench's To fix read and its tab count, which ask the
-- ACTIVE project (`docs/decisions/home-scope.md`) for `fixReason IS NOT NULL`.
-- `fixReason` is NULL on nearly every row, so the non-null range is small.

-- CreateEnum
CREATE TYPE "work_item_fix_reason" AS ENUM ('queue_failed', 'conflicted', 'ci_failed', 'changes_requested');

-- AlterTable
ALTER TABLE "work_item" ADD COLUMN     "fixDetail" JSONB,
ADD COLUMN     "fixReason" "work_item_fix_reason";

-- CreateIndex
CREATE INDEX "work_item_projectId_fixReason_idx" ON "work_item"("projectId", "fixReason");
