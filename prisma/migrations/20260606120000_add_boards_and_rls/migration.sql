-- Board data model (Story 3.1 · Subtask 3.1.1). This migration ships, in one
-- atomic step (migration-by-concern, PRODECT_FINDINGS #20 — every table lands
-- WITH its RLS policy so there is never an unguarded window):
--   1. one enum — `board_type` (kanban / scrum);
--   2. the `board` + `board_column` + `board_column_status` tables, their
--      indexes and FKs;
--   3. ENABLE + FORCE row-level security on all three tables + the tenancy
--      policy.
--
-- A board is a per-project READ PROJECTION over issues: a card's column is
-- DERIVED from `work_item.status` (Story 1.4) via the `board_column_status`
-- mapping; the board stores NO per-card placement of its own. v1 auto-seeds
-- exactly one Kanban board per project (Subtask 3.1.2, application code); board
-- CRUD / multi-board / the Scrum sprint board (Story 3.4) are later, and ship
-- non-breaking on top of this shape (`board.project_id` is non-unique;
-- `BoardType.scrum` exists now so 3.4 adds no enum ALTER).
--
-- ===========================================================================
-- Two deviations from the 3.1.1 card, both resolved toward shipped code
-- (decision-authority ladder rung 2 "shipped code" > rung 3 "the card").
-- Recorded as PRODECT_FINDINGS for Story 3.1.
-- ===========================================================================
-- (a) `board_column.position` is TEXT, NOT `Decimal(20,10)`. The card cited
--     finding #18 for a numeric position, but the SHIPPED position columns
--     (`work_item.position`, `workflow_status.position`) are `String @db.Text`
--     holding opaque base-62 fractional-index keys minted by
--     `lib/workItems/positioning.ts` (the `fractional-indexing` library — a
--     reorder is a single-row rewrite, never a renumber cascade). Using TEXT
--     here keeps column ordering on the SAME mechanism boards/3.1.5 already
--     reuse; a Decimal column would fork a second, incompatible ordering type.
-- (b) NO system-admin escape hatch on the RLS policy. The card asked for the
--     `OR current_setting('app.system_admin', true) = 'true'` hatch "mirroring
--     workflow_status" — but `workflow_status` deliberately has NO such hatch
--     (see 20260602120000_add_workflow_status_and_transition_rls's header).
--     The hatch exists ONLY on `job_run` / `job_run_dlq`, whose writer is the
--     context-less background runtime and which hold untenanted SYSTEM rows
--     (`workspace_id IS NULL`). Neither holds for boards: every board row
--     carries a NON-NULL `workspace_id` and every write happens INSIDE an
--     active workspace context (3.1.2 seeds inside createProject's
--     withWorkspaceContext transaction). So the policy is the PURE workspace
--     gate `project` / `work_item` / `workflow_status` use. Bolting on the
--     hatch would be a latent cross-tenant widening.
--
-- Policy shape (same as add_workflow_status_and_transition_rls's gate):
--   * ENABLE + FORCE so even the table-owner role (`prodect`) is subject to
--     the policy. FORCE does NOT defeat BYPASSRLS on the superuser — that's
--     why production connects as the non-bypass `prodect_app` role
--     (PRODECT_FINDINGS #5), and why the RLS tests drop to it.
--   * `current_setting('app.workspace_id', true)` — the `true` is missing_ok,
--     so an unset GUC yields NULL → predicate NULL → row hidden. Safe failure
--     mode (no context → nothing visible).
--   * FOR ALL on a single permissive policy per table: every board write
--     happens inside an already-active workspace context, so one predicate
--     covers SELECT/INSERT/UPDATE/DELETE via USING + WITH CHECK. WITH CHECK
--     blocks inserting/moving a row into a foreign workspace.
--
-- Grants: the workspace RLS migration's `ALTER DEFAULT PRIVILEGES IN SCHEMA
-- public ... TO prodect_app` auto-grants SELECT/INSERT/UPDATE/DELETE on every
-- NEW table created by the `prodect` role. All three tables here are created
-- by that role, so no explicit GRANT is needed (same as work_item / job_run /
-- workflow_status).
--
-- NOT done here: seeding the default board rows. That is 3.1.2's job, done in
-- application code (`lib/boards/defaultBoard.ts` wired into createProject)
-- under the request context where `app.workspace_id` is bound — a SQL INSERT
-- in this migration could not set the GUC and would be rejected by the FORCE
-- policy under the prodect_app role. This migration does not touch `work_item`
-- (card placement is derived from its existing `status` + `position`).

-- CreateEnum
CREATE TYPE "board_type" AS ENUM ('kanban', 'scrum');

-- CreateTable
CREATE TABLE "board" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "board_type" NOT NULL DEFAULT 'kanban',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "board_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_column" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "board_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" TEXT NOT NULL,
    "wip_limit" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "board_column_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_column_status" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "board_id" TEXT NOT NULL,
    "column_id" TEXT NOT NULL,
    "status_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "board_column_status_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "board_workspace_id_idx" ON "board"("workspace_id");

-- CreateIndex
CREATE INDEX "board_project_id_idx" ON "board"("project_id");

-- CreateIndex
CREATE INDEX "board_column_workspace_id_idx" ON "board_column"("workspace_id");

-- CreateIndex
CREATE INDEX "board_column_board_id_position_idx" ON "board_column"("board_id", "position");

-- CreateIndex
CREATE INDEX "board_column_status_workspace_id_idx" ON "board_column_status"("workspace_id");

-- CreateIndex
CREATE INDEX "board_column_status_column_id_idx" ON "board_column_status"("column_id");

-- CreateIndex
CREATE UNIQUE INDEX "board_column_status_board_id_status_id_key" ON "board_column_status"("board_id", "status_id");

-- AddForeignKey
ALTER TABLE "board" ADD CONSTRAINT "board_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board" ADD CONSTRAINT "board_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_column" ADD CONSTRAINT "board_column_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_column" ADD CONSTRAINT "board_column_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_column" ADD CONSTRAINT "board_column_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "board"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_column_status" ADD CONSTRAINT "board_column_status_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_column_status" ADD CONSTRAINT "board_column_status_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_column_status" ADD CONSTRAINT "board_column_status_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "board"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_column_status" ADD CONSTRAINT "board_column_status_column_id_fkey" FOREIGN KEY ("column_id") REFERENCES "board_column"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_column_status" ADD CONSTRAINT "board_column_status_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "workflow_status"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security — board + board_column + board_column_status
-- ===========================================================================
ALTER TABLE "board" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "board" FORCE ROW LEVEL SECURITY;

ALTER TABLE "board_column" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "board_column" FORCE ROW LEVEL SECURITY;

ALTER TABLE "board_column_status" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "board_column_status" FORCE ROW LEVEL SECURITY;

-- board: pure workspace gate. A board is visible/mutable only when it belongs
-- to the active workspace. USING governs SELECT/UPDATE/DELETE visibility;
-- WITH CHECK governs the post-image of INSERT/UPDATE so a write can't place
-- (or move) a row into a foreign workspace.
CREATE POLICY "board_active_workspace" ON "board"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

-- board_column: identical gate. The denormalized `workspace_id` (kept honest
-- by the FK chain — the board + project share one workspace) makes this a
-- direct comparison, no join.
CREATE POLICY "board_column_active_workspace" ON "board_column"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

-- board_column_status: identical gate. Same denormalized `workspace_id`.
CREATE POLICY "board_column_status_active_workspace" ON "board_column_status"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
