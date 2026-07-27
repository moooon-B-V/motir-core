-- The plan-change CONVERSATION substrate (Story 7.30 · MOTIR-1728) — the
-- persisted, RESUMABLE thread that turns "change my plan" from a one-shot
-- prompt into a refinement dialogue. A `plan_change_session` accumulates
-- ordered `plan_change_turn` rows; submitting hands the ACCUMULATED user turns
-- to the already-shipped plan-edit job contract (`augment`). No new job kind,
-- no motir-ai change — this is composition on top of MOTIR-899/-902/-1347.
--
-- Project-scoped tenant data, so both RLS policies land in THIS SAME migration
-- (migration-by-concern, PRODECT_FINDINGS #20 — no unguarded window). Every FK
-- is modelled as a Prisma `@relation` on BOTH sides with the SAME actions the
-- SQL uses, so `migrate dev` reports "No difference detected" (the
-- FK-`@relation` rule): workspace/project/session CASCADE (tenant, project and
-- thread teardown take their rows with them), author/creator SET NULL (a
-- departed author leaves the conversation intact and unattributed — the
-- `notification` ACTOR semantics). `last_job_id` / `plan_change_turn.job_id`
-- are OPAQUE motir-ai job tokens — plain scalars, NOT FKs (the
-- `plan.source_job_id` precedent).
--
-- Two DB-level guarantees the app layer relies on rather than re-checking:
--   * `plan_change_session_project_id_key` (UNIQUE) — ONE conversation per
--     project, so "open the plan-change thread" is an unambiguous
--     get-or-create and a lost create-race translates from P2002 to a typed
--     domain error (the `migrate_onboarding` precedent).
--   * `plan_change_turn_session_id_seq_key` (UNIQUE) — turn order is gapless
--     and collision-free. The service allocates `seq` under a
--     `SELECT … FOR UPDATE` lock on the session row + a re-read inside the
--     transaction (the lock-before-read-derived-update rule); this unique is
--     the backstop that turns a lost append race into a typed error instead of
--     two turns claiming the same position.

-- CreateEnum
CREATE TYPE "plan_change_turn_role" AS ENUM ('user', 'system');

-- CreateTable
CREATE TABLE "plan_change_session" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "created_by_id" TEXT,
    "turn_count" INTEGER NOT NULL DEFAULT 0,
    "last_job_id" TEXT,
    "last_submitted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plan_change_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_change_turn" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "role" "plan_change_turn_role" NOT NULL,
    "body" TEXT NOT NULL,
    "job_id" TEXT,
    "author_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_change_turn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "plan_change_session_workspace_id_idx" ON "plan_change_session"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "plan_change_session_project_id_key" ON "plan_change_session"("project_id");

-- CreateIndex
CREATE INDEX "plan_change_turn_session_id_seq_idx" ON "plan_change_turn"("session_id", "seq");

-- CreateIndex
CREATE INDEX "plan_change_turn_workspace_id_idx" ON "plan_change_turn"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "plan_change_turn_session_id_seq_key" ON "plan_change_turn"("session_id", "seq");

-- AddForeignKey
ALTER TABLE "plan_change_session" ADD CONSTRAINT "plan_change_session_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_change_session" ADD CONSTRAINT "plan_change_session_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_change_session" ADD CONSTRAINT "plan_change_session_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_change_turn" ADD CONSTRAINT "plan_change_turn_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_change_turn" ADD CONSTRAINT "plan_change_turn_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "plan_change_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_change_turn" ADD CONSTRAINT "plan_change_turn_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ===========================================================================
-- Row-level security — plan_change_session + plan_change_turn
-- ===========================================================================
-- The SAME single PERMISSIVE FOR ALL policy as migrate_onboarding / import /
-- plan / sprint / comment: USING + WITH CHECK against
-- current_setting('app.workspace_id', true) (`true` = missing_ok, so an unset
-- GUC yields NULL → predicate NULL → row hidden, the safe failure). ENABLE +
-- FORCE so even the table-owner `prodect` role is subject to it (production +
-- the service writes connect as the non-BYPASSRLS `prodect_app` role). The
-- workspace RLS migration's `ALTER DEFAULT PRIVILEGES … TO prodect_app`
-- auto-grants on every NEW table created by the `prodect` role, so no explicit
-- GRANT is needed.
--
-- The TURN table carries its own `workspace_id` (denormalized from its session)
-- and its own policy rather than leaning on the session's — a child table with
-- no policy of its own is readable cross-tenant by anyone who guesses a
-- session id, and RLS does not traverse FKs.
ALTER TABLE "plan_change_session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plan_change_session" FORCE ROW LEVEL SECURITY;

CREATE POLICY "plan_change_session_active_workspace" ON "plan_change_session"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

ALTER TABLE "plan_change_turn" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plan_change_turn" FORCE ROW LEVEL SECURITY;

CREATE POLICY "plan_change_turn_active_workspace" ON "plan_change_turn"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
