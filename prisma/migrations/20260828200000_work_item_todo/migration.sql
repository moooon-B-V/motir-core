-- The WORK-ITEM TO-DO LIST — the ordered steps of one card's own work
-- (Story MOTIR-3808 · MOTIR-3813), specified by
-- `docs/decisions/work-item-todo-list.md`.
--
-- Workspace-scoped tenant data, so its RLS policy lands in THIS SAME migration
-- (migration-by-concern, PRODECT_FINDINGS #20 — no unguarded window), and
-- `workspace_id` is carried on the ROW because RLS does not traverse foreign
-- keys. Which of the schema's two tenancy shapes applies is decided by the
-- TIER: `comment` is a direct child of `work_item` and carries its own
-- `workspace_id`; `comment_mention` is a grandchild and reaches tenancy through
-- its parent. A to-do is a direct child, so it takes the comment's shape.
--
-- All three FKs are modelled as Prisma `@relation`s (forward + back-relation)
-- with the SAME actions this SQL uses, so `migrate diff` reports no drift — the
-- FK-`@relation` rule in CLAUDE.md, and the reason the `build` job now runs
-- `migrate diff --exit-code` against its from-empty replay.
--
-- ON DELETE, one row at a time, because two of the three differ:
--
--   * `workspace_id`  CASCADE — a deleted workspace's rows are not a fact.
--   * `work_item_id`  CASCADE — the `comment` semantics: a card's steps die
--                     with the card. (NOT the `attachment` SetNull shape, which
--                     exists only so an orphan-GC can still reclaim a blob;
--                     a to-do owns no external object.)
--   * `done_by_id`    SET NULL — a departing member must not vaporise the
--                     record that a step was completed. The tick survives; its
--                     attribution does not.
--
-- INDEXES, and neither is the `(work_item_id, created_at)` its neighbours use:
--
--   * `(work_item_id, position)` — this list is ORDERED, not chronological. The
--     section reads a card's whole list in display order, so the index serves
--     the read without a sort.
--   * `(workspace_id)` — as every tenant table carries.
--
-- NO UNIQUE INDEX ON `position`. Fractional keys are minted between neighbours
-- and a concurrent insert at the same slot is serialized by the service's
-- `FOR UPDATE` lock on those neighbours, not by a constraint: a unique index
-- here would convert a benign near-collision into a failed user action, and the
-- ordering it would protect is already a total order via (position, id).

-- CreateTable
CREATE TABLE "work_item_todo" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "work_item_id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "command_text" TEXT,
    "executor" "executor",
    "position" TEXT NOT NULL,
    "done_at" TIMESTAMP(3),
    "done_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_item_todo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "work_item_todo_work_item_id_position_idx" ON "work_item_todo"("work_item_id", "position");

-- CreateIndex
CREATE INDEX "work_item_todo_workspace_id_idx" ON "work_item_todo"("workspace_id");

-- AddForeignKey
ALTER TABLE "work_item_todo" ADD CONSTRAINT "work_item_todo_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_todo" ADD CONSTRAINT "work_item_todo_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_todo" ADD CONSTRAINT "work_item_todo_done_by_id_fkey" FOREIGN KEY ("done_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS, in the same migration as the table (no unguarded window). FORCE so even
-- the table-owner role is subject to it — production and the service writes
-- connect as the non-BYPASSRLS app role.
--
-- The gate is the row's OWN `workspace_id`, not a join through `work_item` —
-- RLS does not traverse foreign keys. This is `workflow_status_active_workspace`
-- and `work_item_delivery_active_workspace` byte for byte.
--
-- NO `app.system_admin` ARM, and that is a decision rather than an omission.
-- An arm is added for a caller that genuinely has no workspace context — the
-- jobs runtime writing untenanted ledger rows, operator tooling spanning
-- workspaces. Every row here has a NON-NULL `workspace_id` and every write is
-- made by a person acting inside one workspace on one card, so there is no such
-- caller to admit; `comment`, whose shape this copies, carries none for exactly
-- the same reason. An arm nobody needs is a hole nobody is watching.
--
-- `current_setting(..., true)` is missing_ok, so an unset GUC yields NULL, the
-- predicate is NULL, and the row is hidden — no context means nothing visible,
-- which is the safe failure.
--
-- The workspace RLS migration's `ALTER DEFAULT PRIVILEGES … TO prodect_app` (the historical role name, still the real one)
-- auto-grants on every NEW table created by the owner role, so no explicit
-- GRANT is needed (same as work_item_delivery / work_item_repository / sprint).
ALTER TABLE "work_item_todo" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "work_item_todo" FORCE ROW LEVEL SECURITY;

CREATE POLICY "work_item_todo_active_workspace" ON "work_item_todo"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
