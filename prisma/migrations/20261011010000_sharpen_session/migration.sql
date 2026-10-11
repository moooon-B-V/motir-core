-- The SHARPEN session store (Task MOTIR-1101 · Subtask MOTIR-8182) — one
-- person's grilling conversation about WHAT a plan or one committed work item
-- is. A dedicated pair of tables rather than a `plan_change_session` origin:
-- that model is scoped by work-item keys with no plan scope, and its `origin` /
-- turn `intent` enums are read by the planning, guide and conversation doors.
--
-- Every FK is modelled as a Prisma `@relation` on both sides with the same
-- actions as below (the FK-`@relation` rule). `job_id` is an OPAQUE motir-ai
-- job token, a plain scalar like `plan.source_job_id`.
--
-- Four DB-level guarantees the door (MOTIR-8181) relies on rather than
-- re-checking:
--   * `sharpen_session_scope_check` — exactly one of `plan_id` / `work_item_id`
--     is set, and it is the one `scope_kind` names.
--   * `sharpen_session_open_plan_key` / `sharpen_session_open_work_item_key` —
--     ONE OPEN session per person per target. Partial, so an ENDED session never
--     blocks a new one; a lost open-race surfaces as a unique violation the
--     service turns into "return the winner".
--   * `sharpen_turn_session_id_seq_key` — gapless, collision-free turn order
--     (allocated under the session row's `FOR UPDATE` lock).
--   * `sharpen_turn_planner_job_key` — a motir-ai job settles into at most ONE
--     planner turn, so a replayed settle cannot store a result twice.
--
-- The partial indexes are deliberately NOT `@@index`/`@@unique` in the schema
-- (a WHERE clause is inexpressible there), and no `@@index` claims their column
-- lists, so `migrate diff` stays clean (the partial-index rule).

-- CreateEnum
CREATE TYPE "sharpen_scope_kind" AS ENUM ('plan', 'work_item');

-- CreateEnum
CREATE TYPE "sharpen_session_status" AS ENUM ('open', 'ended');

-- CreateEnum
CREATE TYPE "sharpen_end_reason" AS ENUM ('nothing_to_ask', 'finished', 'stopped');

-- CreateEnum
CREATE TYPE "sharpen_turn_role" AS ENUM ('person', 'planner');

-- CreateEnum
CREATE TYPE "sharpen_action" AS ENUM ('start', 'answer', 'own_words', 'skip', 'you_decide', 'stop');

-- CreateTable
CREATE TABLE "sharpen_session" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "scope_kind" "sharpen_scope_kind" NOT NULL,
    "plan_id" TEXT,
    "work_item_id" TEXT,
    "status" "sharpen_session_status" NOT NULL DEFAULT 'open',
    "end_reason" "sharpen_end_reason",
    "pending_question" JSONB,
    "settled" JSONB NOT NULL DEFAULT '[]',
    "assumptions" JSONB NOT NULL DEFAULT '[]',
    "write_back" JSONB,
    "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sharpen_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sharpen_turn" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "role" "sharpen_turn_role" NOT NULL,
    "action" "sharpen_action",
    "body" TEXT NOT NULL,
    "reading_id" TEXT,
    "job_id" TEXT,
    "record" JSONB,
    "author_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sharpen_turn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sharpen_session_workspace_id_idx" ON "sharpen_session"("workspace_id");

-- CreateIndex
CREATE INDEX "sharpen_session_project_id_idx" ON "sharpen_session"("project_id");

-- CreateIndex
CREATE INDEX "sharpen_session_plan_id_idx" ON "sharpen_session"("plan_id");

-- CreateIndex
CREATE INDEX "sharpen_session_work_item_id_idx" ON "sharpen_session"("work_item_id");

-- CreateIndex
CREATE INDEX "sharpen_turn_workspace_id_idx" ON "sharpen_turn"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "sharpen_turn_session_id_seq_key" ON "sharpen_turn"("session_id", "seq");

-- AddForeignKey
ALTER TABLE "sharpen_session" ADD CONSTRAINT "sharpen_session_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sharpen_session" ADD CONSTRAINT "sharpen_session_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sharpen_session" ADD CONSTRAINT "sharpen_session_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sharpen_session" ADD CONSTRAINT "sharpen_session_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sharpen_session" ADD CONSTRAINT "sharpen_session_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sharpen_turn" ADD CONSTRAINT "sharpen_turn_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sharpen_turn" ADD CONSTRAINT "sharpen_turn_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sharpen_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sharpen_turn" ADD CONSTRAINT "sharpen_turn_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Exactly one target, and it matches the scope kind.
ALTER TABLE "sharpen_session" ADD CONSTRAINT "sharpen_session_scope_check" CHECK (
  ("scope_kind" = 'plan' AND "plan_id" IS NOT NULL AND "work_item_id" IS NULL)
  OR ("scope_kind" = 'work_item' AND "work_item_id" IS NOT NULL AND "plan_id" IS NULL)
);

-- ONE OPEN session per person per target.
CREATE UNIQUE INDEX "sharpen_session_open_plan_key" ON "sharpen_session"("created_by_id", "plan_id")
  WHERE "status" = 'open';
CREATE UNIQUE INDEX "sharpen_session_open_work_item_key" ON "sharpen_session"("created_by_id", "work_item_id")
  WHERE "status" = 'open';

-- A job settles into at most one planner turn.
CREATE UNIQUE INDEX "sharpen_turn_planner_job_key" ON "sharpen_turn"("session_id", "job_id")
  WHERE "role" = 'planner';

-- ===========================================================================
-- Row-level security — sharpen_session + sharpen_turn
-- ===========================================================================
-- The SAME single PERMISSIVE FOR ALL policy shape as plan_change_session /
-- plan_change_turn: USING + WITH CHECK against
-- current_setting('app.workspace_id', true) (missing_ok, so an unset GUC hides
-- every row — the safe failure). ENABLE + FORCE so the table owner is subject to
-- it too. The turn table carries its own `workspace_id` and its own policy: RLS
-- does not traverse FKs, so a child table without one would be readable
-- cross-tenant by anyone who guessed a session id.
ALTER TABLE "sharpen_session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sharpen_session" FORCE ROW LEVEL SECURITY;

CREATE POLICY "sharpen_session_active_workspace" ON "sharpen_session"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

ALTER TABLE "sharpen_turn" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sharpen_turn" FORCE ROW LEVEL SECURITY;

CREATE POLICY "sharpen_turn_active_workspace" ON "sharpen_turn"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
