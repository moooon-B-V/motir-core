-- Sprint + backlog data model (Story 4.1 · Subtask 4.1.1). This migration ships,
-- in one atomic step (migration-by-concern, PRODECT_FINDINGS #20 — the table
-- lands WITH its RLS policy so there is never an unguarded window):
--   1. the `sprint_state` enum (planned / active / complete);
--   2. the `sprint` table, its indexes + FKs (project-scoped — see below);
--   3. `work_item.sprintId` (the issue↔sprint association, NULL = backlog) +
--      `work_item.backlogRank` (the global fractional-index ordering) + the
--      composite index that serves both the backlog and a sprint's issues;
--   4. the `sprint_one_active_per_project` PARTIAL unique index;
--   5. ENABLE + FORCE row-level security on `sprint` + the tenancy policy;
--   6. a one-time backfill that gives every existing issue a `backlogRank`.
--
-- A sprint is scoped to the PROJECT, not a board. In Jira a sprint hangs off a
-- board (`originBoardId`) because a Jira board is a cross-project saved-filter
-- view; in THIS product a board is a per-project READ projection (Story 3.1), so
-- a project has one logical sprint sequence regardless of how many scrum boards
-- (Story 3.7) view it. (Justified rung-1 deviation — see
-- scripts/plan-seed/data/story-4.1.ts.) Hence `sprint.project_id` + a denormalized
-- `sprint.workspace_id` (the RLS gate, matching `board` / `work_item`), and "one
-- active sprint per board" resolves to "one active sprint per PROJECT".
--
-- ===========================================================================
-- Deviation from the 4.1.1 card, resolved toward shipped code (decision-
-- authority ladder rung 2 "shipped code" > rung 3 "the card").
-- ===========================================================================
-- The card asked for `work_item.sprint_id` / `work_item.backlog_rank` (snake_case
-- `@map`). But `work_item`'s 20 EXISTING columns are camelCase with NO `@map`
-- (`workspaceId`, `assigneeId`, `parentId`, `estimateMinutes`, …; the RLS policy
-- in 20260601074342_add_work_item_rls references `"workspaceId"`). Adding
-- snake_case columns would make `work_item` the only mixed-naming table. So the
-- new columns are camelCase `"sprintId"` / `"backlogRank"`, consistent with the
-- table. (The brand-new `sprint` table follows the recent board-era snake_case
-- `@map` convention — that's a fresh table, no within-table conflict.)
--
-- RLS policy shape (same gate as add_boards_and_rls / add_workflow_status_*):
--   * ENABLE + FORCE so even the table-owner role (`prodect`) is subject to the
--     policy. FORCE does NOT defeat BYPASSRLS on the superuser — production
--     connects as the non-bypass `prodect_app` role (PRODECT_FINDINGS #5).
--   * `current_setting('app.workspace_id', true)` — `true` is missing_ok, so an
--     unset GUC yields NULL → predicate NULL → row hidden (safe failure mode).
--   * FOR ALL on a single permissive policy: every sprint write happens inside an
--     already-active workspace context, so one predicate covers
--     SELECT/INSERT/UPDATE/DELETE via USING + WITH CHECK. WITH CHECK blocks
--     inserting/moving a row into a foreign workspace.
--   * NO system-admin escape hatch — `sprint` carries a NON-NULL `workspace_id`
--     and every write is tenanted, exactly like `board` / `workflow_status`
--     (the hatch exists only on the untenanted `job_run*` tables).
-- Grants: the workspace RLS migration's `ALTER DEFAULT PRIVILEGES … TO
-- prodect_app` auto-grants on every NEW table created by the `prodect` role, so
-- `sprint` needs no explicit GRANT (same as board / work_item / workflow_status).
--
-- The new `work_item` columns live on the already-ENABLE+FORCE-RLS `work_item`
-- table (20260601074342) — adding a column inherits the row policy, so tenant
-- isolation is unchanged and no RLS change is needed there.

-- CreateEnum
CREATE TYPE "sprint_state" AS ENUM ('planned', 'active', 'complete');

-- AlterTable
ALTER TABLE "work_item" ADD COLUMN     "backlogRank" TEXT,
ADD COLUMN     "sprintId" TEXT;

-- CreateTable
CREATE TABLE "sprint" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "goal" TEXT,
    "state" "sprint_state" NOT NULL DEFAULT 'planned',
    "start_date" TIMESTAMP(3),
    "end_date" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "sequence" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sprint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sprint_workspace_id_idx" ON "sprint"("workspace_id");

-- CreateIndex
CREATE INDEX "sprint_project_id_state_idx" ON "sprint"("project_id", "state");

-- CreateIndex
CREATE INDEX "work_item_projectId_sprintId_backlogRank_idx" ON "work_item"("projectId", "sprintId", "backlogRank");

-- AddForeignKey
ALTER TABLE "work_item" ADD CONSTRAINT "work_item_sprintId_fkey" FOREIGN KEY ("sprintId") REFERENCES "sprint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sprint" ADD CONSTRAINT "sprint_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sprint" ADD CONSTRAINT "sprint_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Partial unique index — at most ONE active sprint per project
-- ===========================================================================
-- Only rows with `state = 'active'` participate, so a project may have many
-- planned/complete sprints but never two active ones. A second active
-- insert/update for the same project fails with unique_violation (SQLSTATE
-- 23505). Prisma's DSL cannot express a filtered unique index, so it lives here
-- as raw SQL — exactly like `board_one_default_per_project` /
-- `workflow_status_one_initial_per_project`. The Story-4.4 start flow keeps the
-- transition atomic; this index is the DB-level backstop.
CREATE UNIQUE INDEX "sprint_one_active_per_project"
  ON "sprint"("project_id")
  WHERE "state" = 'active';

-- ===========================================================================
-- Row-level security — sprint (pure workspace gate, no escape hatch)
-- ===========================================================================
ALTER TABLE "sprint" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sprint" FORCE ROW LEVEL SECURITY;

CREATE POLICY "sprint_active_workspace" ON "sprint"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

-- ===========================================================================
-- Backlog-rank backfill — make the per-project ordering total from day one
-- ===========================================================================
-- Every EXISTING work_item gets a `backlogRank` so Story 4.2's backlog read has
-- a total order immediately. Keys are the SAME opaque base-62 fractional-index
-- scheme lib/workItems/positioning.ts emits, so ranks minted later by
-- keyForAppend / keyBetween (Story 4.1.4) interleave with these. Per project,
-- issues are ordered by (created_at, id) and assigned FIXED-WIDTH base-62 keys:
-- width W is the digits needed for the project's issue count, and the header
-- char encodes that width (fractional-indexing's getIntegerLength: 'a'→2 =
-- head + 1 digit, 'b'→3, …). So every key is a valid fractional-indexing
-- integer key, and equal-length keys sort numerically under the DB's C collation
-- (datcollate = 'C' — the same assumption every `ORDER BY position` read already
-- relies on; the base-62 alphabet 0-9A-Za-z is in ASCII order).
--
-- The column stays NULLABLE: new issues get a rank at creation in Story 4.1.4 —
-- this backfill only makes the PRE-EXISTING set total. The helper function is
-- dropped at the end so the migration leaves no stray object behind.
CREATE FUNCTION "_sprint_backlog_rank_key"(n bigint, cnt bigint) RETURNS text AS $$
DECLARE
  alphabet constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  w      int    := 1;
  cap    bigint := 62;
  v      bigint := n;
  digits text   := '';
  i      int;
BEGIN
  -- smallest W such that 62^W >= cnt (values 0..cnt-1 fit in W base-62 digits)
  WHILE cap < cnt LOOP
    cap := cap * 62;
    w := w + 1;
  END LOOP;
  FOR i IN 1..w LOOP
    digits := substr(alphabet, (v % 62)::int + 1, 1) || digits;
    v := v / 62;
  END LOOP;
  -- header char 'a'+(W-1) → getIntegerLength(head) = W+1 = total key length
  RETURN chr(ascii('a') + w - 1) || digits;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

WITH ranked AS (
  SELECT
    "id",
    row_number() OVER (PARTITION BY "projectId" ORDER BY "createdAt" ASC, "id" ASC) - 1 AS rn,
    count(*)     OVER (PARTITION BY "projectId")                                       AS cnt
  FROM "work_item"
)
UPDATE "work_item" w
SET "backlogRank" = "_sprint_backlog_rank_key"(r.rn, r.cnt)
FROM ranked r
WHERE w."id" = r."id";

DROP FUNCTION "_sprint_backlog_rank_key"(bigint, bigint);
