-- The merge policy moves to the PROJECT and loses its `subtask` name (MOTIR-4880 ·
-- MOTIR-5177, `docs/decisions/approval-gates.md` §7 and its 2026-09-13 amendment).
--
-- This is the EXPAND half and changes no behaviour: nothing has ever branched on the
-- value. `workspace.subtaskPrMergeMode` STAYS — column and Prisma field — because the
-- datamodel declaration is itself a reader, so retiring it takes three releases
-- (Story MOTIR-5175).
--
-- 1. The enum is RENAMED IN PLACE, before the column is added, so the new column
--    references the renamed type and the workspace column keeps pointing at the same
--    one. One type, two columns, for the length of the expand window.
-- 1b. ⚠️ AND ITS RESERVED `review_on_fail` MEMBER IS RETIRED (Yue, 2026-09-13). Only a
--    GREEN pull request is ever a merge candidate, so no meaning survives for "ask
--    when checks fail". It was reserved "to avoid a later enum ALTER", which had the
--    cost backwards: `ADD VALUE` is cheap, and removing a value is this block. Postgres
--    cannot drop an enum member, so the type is rebuilt with `auto` and `manual` only.
--    Any workspace holding the retired value is mapped to `manual`, which is exactly
--    how it behaved. It runs before the project column exists, so one column moves.
-- 2. `project.pr_merge_mode` is added with `manual` as a FLOOR. The provenance default
--    cannot be a column default — a project exists before it has repositories — and is
--    written at establishment by application code (MOTIR-5178).
-- 3. ⚠️ THE BACKFILL IS WHAT MAKES THIS SAFE. Every project takes its workspace's
--    CURRENT value, so an organisation that had `auto` does not find its projects at
--    `manual`. Nobody's effective answer changes on the day this lands.
-- 4. `project.pr_merge_mode_decided_at` stamps a value as DECIDED, and the
--    establishment default writes only where it is NULL. The backfill stamps a project
--    that is ALREADY ESTABLISHED (it holds a settled repository row), because no
--    establishment event will ever arrive for it and the carried value must not be
--    overwritten later. A project not yet established stays unstamped and gets the
--    provenance default when it establishes; its carried value was never choosable by
--    anyone — the workspace column was never rendered and never read.
--
-- Idempotent, so a re-run of `migrate deploy` over a half-applied database is safe.

-- 1. Rename the type in place.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subtask_pr_merge_mode')
     AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pr_merge_mode') THEN
    ALTER TYPE "subtask_pr_merge_mode" RENAME TO "pr_merge_mode";
  END IF;
END $$;

-- 1b. Retire `review_on_fail`: rebuild the type with the two live members.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'pr_merge_mode' AND e.enumlabel = 'review_on_fail'
  ) THEN
    UPDATE "workspace" SET "subtaskPrMergeMode" = 'manual'
     WHERE "subtaskPrMergeMode" = 'review_on_fail';
    CREATE TYPE "pr_merge_mode_v2" AS ENUM ('auto', 'manual');
    ALTER TABLE "workspace" ALTER COLUMN "subtaskPrMergeMode" DROP DEFAULT;
    ALTER TABLE "workspace" ALTER COLUMN "subtaskPrMergeMode" TYPE "pr_merge_mode_v2"
      USING ("subtaskPrMergeMode"::text::"pr_merge_mode_v2");
    ALTER TABLE "workspace" ALTER COLUMN "subtaskPrMergeMode" SET DEFAULT 'manual';
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_name = 'project' AND column_name = 'pr_merge_mode'
    ) THEN
      UPDATE "project" SET "pr_merge_mode" = 'manual' WHERE "pr_merge_mode" = 'review_on_fail';
      ALTER TABLE "project" ALTER COLUMN "pr_merge_mode" DROP DEFAULT;
      ALTER TABLE "project" ALTER COLUMN "pr_merge_mode" TYPE "pr_merge_mode_v2"
        USING ("pr_merge_mode"::text::"pr_merge_mode_v2");
      ALTER TABLE "project" ALTER COLUMN "pr_merge_mode" SET DEFAULT 'manual';
    END IF;
    DROP TYPE "pr_merge_mode";
    ALTER TYPE "pr_merge_mode_v2" RENAME TO "pr_merge_mode";
  END IF;
END $$;

-- 2. The project-tier columns.
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "pr_merge_mode" "pr_merge_mode" NOT NULL DEFAULT 'manual';
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "pr_merge_mode_decided_at" TIMESTAMP(3);

-- 3. Backfill: every project carries its workspace's current value.
UPDATE "project" AS p
   SET "pr_merge_mode" = w."subtaskPrMergeMode"
  FROM "workspace" AS w
 WHERE w."id" = p."workspaceId";

-- 4. Stamp the projects that are already established.
UPDATE "project" AS p
   SET "pr_merge_mode_decided_at" = CURRENT_TIMESTAMP
 WHERE p."pr_merge_mode_decided_at" IS NULL
   AND EXISTS (
     SELECT 1
       FROM "project_repository" AS r
      WHERE r."project_id" = p."id"
        AND r."state" IN ('created', 'connected', 'skipped')
   );
