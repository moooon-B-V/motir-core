-- `work_item.completedAt` — WHEN a card finished (Story MOTIR-4777 · MOTIR-4780).
--
-- Motir has never recorded the moment a work item completed. `model WorkItem`
-- carried `createdAt` / `updatedAt` and nothing else, and there is no
-- status-history table to derive it from — `workflow_transition` models the
-- workflow's ALLOWED edges, not a log of the ones that were taken. So the
-- Workbench's "Recently finished" tab (MOTIR-4781) had no honest column to key
-- its window on, and neither does any cycle-time or throughput report that
-- wants to say how fast the loop actually runs.
--
-- ⚠️ `updated_at` IS NOT A SUBSTITUTE. It moves on any edit, so a
-- "finished this week" list built on it lists work finished in June that
-- somebody re-titled today. That is the specific wrong answer this column
-- exists to stop, which is also why the backfill below is labelled the way it
-- is.
--
-- CAMELCASE, NO SNAKE-CASE MAP. Every one of `work_item`'s 35 other columns is
-- camelCase and unmapped (only the TABLE carries an `@@map`), and the schema
-- records that within-table-consistency call twice already — on `storyPoints`
-- and on `sprintId` / `backlogRank`, both naming decision-authority rung 2 as
-- what outranks a card's `@map` prose. A single snake_case column here would be
-- the drift those two notes were written to prevent. MOTIR-4780's AC 1 spells
-- the physical column `completed_at`; it is amended on the record to
-- `completedAt` for that reason, and the semantic half of the criterion — the
-- stamp, its category resolution, its transaction — is unchanged.
--
-- NO RLS CHANGE. This is a column on an existing table, so it inherits
-- `work_item`'s policies unchanged — the same reason the `targetRepos` scalar
-- array was preferred to a join table.

-- AlterTable
ALTER TABLE "work_item" ADD COLUMN     "completedAt" TIMESTAMP(3);

-- ⚠️ THE BACKFILL IS AN APPROXIMATION, AND IT IS LABELLED HERE SO NOBODY LATER
-- READS AN OLD VALUE AS A MEASUREMENT.
--
-- Every row already sitting in a done-category status finished at some moment
-- this database did not record. `updated_at` is the closest thing that exists,
-- and for a card that was closed and never touched again it is exactly right;
-- for one that was closed in June and re-titled in August it is the re-title.
-- There is no way to tell the two apart from the data, so:
--
--   * a `completedAt` on a row created BEFORE this migration is an
--     approximation of unknown quality, never evidence about when work finished;
--   * a `completedAt` written AFTER it is a real observation, stamped inside the
--     same transaction as the status write that caused it.
--
-- Anything computing cycle time, throughput or a "finished in the last N days"
-- figure over historical rows is reading the first kind. The rolling window the
-- Workbench uses is 7 days, so it walks past this backfill within a week of
-- deploy; a report over a longer horizon does not, and owes the caveat.
--
-- CATEGORY, not a key literal. The done set is `workflow_status.category =
-- 'done'` for THAT ROW'S OWN PROJECT — `done` and `cancelled` out of the box,
-- plus anything a workspace has defined. A hardcoded `IN ('done','cancelled')`
-- would silently skip every project that renamed its terminal column, which is
-- the same defect MOTIR-2758 fixed on the read side.
UPDATE "work_item" wi
SET "completedAt" = wi."updatedAt"
FROM "workflow_status" ws
WHERE ws."project_id" = wi."projectId"
  AND ws."key" = wi."status"
  AND ws."category" = 'done'
  AND wi."completedAt" IS NULL;

-- CreateIndex
--
-- The finished-window read: one project, a `completedAt` range, ordered
-- `completedAt DESC`. Serving the predicate and the sort off one composite is
-- what keeps the tab from scanning every finished row the project has ever had.
-- The column list is distinct from every other index on this table, so Prisma's
-- differ cannot pair it to an existing one and propose a spurious rename
-- (the migrate-dev-no-drift contract, CLAUDE.md).
CREATE INDEX "work_item_projectId_completedAt_idx" ON "work_item"("projectId", "completedAt");
