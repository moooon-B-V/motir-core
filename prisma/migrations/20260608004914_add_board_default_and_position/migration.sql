-- Multiple boards per project (Story 3.7 · Subtask 3.7.2). The `board` table
-- becomes first-class multi-per-project: a DEFAULT-board flag + a switcher
-- ORDERING position. The per-project board index was already non-unique
-- (3.1.1), so N boards per project were always allowed; this story makes the
-- "which one is default" + "in what order" first-class.
--
--   1. `board.is_default BOOLEAN NOT NULL DEFAULT false` — exactly ONE default
--      board per project. The "at most one default" invariant is a PARTIAL
--      unique index (`board_one_default_per_project`, `WHERE is_default`) —
--      Prisma's schema DSL cannot express a filtered unique index, so it lives
--      here as raw SQL, exactly like `workflow_status_one_initial_per_project`.
--      A second `is_default = true` insert/update for the same project fails
--      with a unique_violation (SQLSTATE 23505). The service keeps the flip
--      atomic (3.7.3 `setDefaultBoard`); this index is the DB-level backstop.
--   2. `board.position TEXT` — the SAME opaque base-62 fractional-index String
--      the `work_item` / `board_column` / `workflow_status` positions use, for
--      stable switcher ordering. App-assigned (no DB default), so a reorder is
--      a single-row write — same convention as every other `position` column.
--
-- BACKFILL — no project may be left without a default. Today every project has
-- exactly ONE board (3.1's auto-seeded board; CRUD lands in 3.7.3), so EVERY
-- existing board becomes its project's default, which trivially satisfies the
-- partial unique index (one board per project → one default per project). Each
-- backfills to the first fractional-index key (`a0`, = generateKeyBetween(null,
-- null)) — the value `keyForAppend(null)` mints, matching the seed path so a
-- migrated board and a freshly-seeded board carry the same initial position.
-- `position` is added NULLABLE, backfilled, then set NOT NULL so the add is
-- safe on a non-empty table.
--
-- NO RLS change: both columns live on the already-ENABLE+FORCE-RLS `board`
-- table (20260606120000_add_boards_and_rls); adding a column inherits the row
-- policy — tenant isolation is unchanged.
--
-- (The auto-generated diff also wanted to DROP the hand-managed
-- `attachment_uploader_user_id_fkey` — `Attachment.uploaderUserId` is a SCALAR
-- whose FK lives in migration SQL, not the Prisma model graph, so `migrate dev`
-- always re-proposes that drop. It is unrelated to this subtask and
-- deliberately omitted, matching how prior board migrations were curated.)

-- AlterTable — is_default (safe: NOT NULL with a default), position (nullable
-- first so the add is safe on a non-empty table; set NOT NULL after backfill).
ALTER TABLE "board" ADD COLUMN     "is_default" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "position" TEXT;

-- Backfill — every existing board is its project's sole board today, so it
-- becomes that project's default; all start at the first fractional-index key.
UPDATE "board" SET "is_default" = true, "position" = 'a0';

-- position is now populated for every row → enforce NOT NULL.
ALTER TABLE "board" ALTER COLUMN "position" SET NOT NULL;

-- DropIndex — replaced by the (project_id, position) composite below; the
-- leftmost-prefix rule means project_id-only lookups still use it.
DROP INDEX "board_project_id_idx";

-- CreateIndex — the switcher lists a project's boards ordered by position.
CREATE INDEX "board_project_id_position_idx" ON "board"("project_id", "position");

-- CreateIndex — partial unique: at most ONE default board per project. Only
-- rows with `is_default = true` participate, so a project may have many
-- non-default boards but never two defaults. A second default insert/update
-- fails with unique_violation (SQLSTATE 23505).
CREATE UNIQUE INDEX "board_one_default_per_project"
  ON "board"("project_id")
  WHERE "is_default" = true;
