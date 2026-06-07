-- Board swimlane grouping (Story 3.3 · Subtask 3.3.2). The ONLY schema change
-- Story 3.3 needs: persist the swimlane group-by on the `board` entity. The
-- per-column WIP limit reuses `board_column.wip_limit` (shipped nullable by
-- Story 3.1.1 explicitly FOR 3.3), so there is NO WIP migration here.
--
--   1. one enum — `board_swimlane_group_by` (none / assignee / epic / priority),
--      the stub-specified group-by dimensions. Adding a value later (e.g. a
--      custom-query lane) is a non-breaking enum addition — same as
--      `board_type.scrum` shipping ahead of Story 3.4.
--   2. `board.swimlane_group_by` NOT NULL DEFAULT 'none'. `none` is the flat 3.2
--      board, so every existing/seeded board defaults to it with NO backfill.
--
-- NO new table and NO RLS change: the column lives on the already-ENABLE+FORCE
-- RLS `board` table (20260606120000_add_boards_and_rls), so tenant isolation is
-- inherited — adding a column does not touch the row policy.
--
-- (The auto-generated diff also wanted to DROP the hand-managed
-- `attachment_uploader_user_id_fkey` — `Attachment.uploaderUserId` is a SCALAR
-- whose FK lives in migration SQL, not the Prisma model graph (see the model
-- comment), so `migrate dev` always re-proposes that drop. It is unrelated to
-- this subtask and deliberately omitted, matching how prior migrations were
-- curated.)

-- CreateEnum
CREATE TYPE "board_swimlane_group_by" AS ENUM ('none', 'assignee', 'epic', 'priority');

-- AlterTable
ALTER TABLE "board" ADD COLUMN     "swimlane_group_by" "board_swimlane_group_by" NOT NULL DEFAULT 'none';
