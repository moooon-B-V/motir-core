-- The DISPATCH RUN record (Story MOTIR-1789 · MOTIR-1791), specified by
-- `docs/decisions/dispatch-run-record.md`.
--
-- Three tables: a run HEADER (`dispatch_run`), one LEG per card
-- (`dispatch_run_card`) and the ordered event stream (`dispatch_run_event`).
-- The leg is the model that makes a SET expressible — `motir run <story>` claims
-- every member of a scope in one transaction, `motir batch` freezes what it will
-- skip before it dispatches anything, and both facts need somewhere to live that
-- is not a card's own row.
--
-- ⚠️ NOT a `job_run`. That table records a server-side job Motir schedules and
-- executes; this one records a CLI command run on somebody else's machine, which
-- Motir only ever hears about. The index shapes are deliberately borrowed from
-- it — including the `(status, started_at)` one the abandoned-run reap reads —
-- because the ledger PROBLEM is the same even though the subject is not.
--
-- Workspace-scoped tenant data, so RLS lands in THIS SAME migration
-- (migration-by-concern — no window in which the tables exist unguarded), and
-- `workspace_id` is carried on EVERY row because RLS does not traverse foreign
-- keys. Every FK is modelled as a Prisma `@relation` on both sides with the same
-- actions this SQL uses, so `migrate diff` reports no drift.
--
-- The nullable FKs are a decision rather than a convenience:
--   * `work_item_id` / `scope_work_item_id` / `created_by_id` are `SET NULL` —
--     a run's history outlives a deleted card and a deleted operator, and the
--     leg keeps `work_item_key` so it can still say WHICH card it was;
--   * both child tables `CASCADE` from the run, because an event or a leg with
--     no run is not a partial record, it is a fragment.
--
-- The two UNIQUE indexes are corruption this must make impossible in the
-- DATABASE rather than "the service checks first":
--   * `dispatch_run_card(dispatch_run_id, work_item_id)` — one leg per card per
--     run. NULLs are DISTINCT in Postgres, which is the behaviour wanted here:
--     two cards deleted out from under one run must both keep their legs rather
--     than collide on a unique violation during the `SET NULL`;
--   * `dispatch_run_event(dispatch_run_id, seq)` — the ordering guarantee AND
--     the append's idempotency key, so a redelivered batch converges on the rows
--     it already wrote instead of duplicating the stream a client is tailing.
--
-- ⚠️ WHAT IS DELIBERATELY ABSENT, and must stay absent (ADR Q3): no
-- pull-request, no CI verdict, no work-item status, no token / credit / cost
-- column on any of the three tables. Each of those facts already has exactly one
-- owner (`work_item_delivery` + `derivePrCiState`; the CLI's transitions;
-- motir-ai's metering), and a second copy is how two surfaces start telling one
-- person different things about whether their work shipped.
-- `tests/dispatchRunSchemaBoundaries.test.ts` asserts it over the generated
-- client's field names.


-- CreateEnum
CREATE TYPE "dispatch_command" AS ENUM ('next', 'run', 'run_scope', 'batch', 'auto');

-- CreateEnum
CREATE TYPE "dispatch_run_origin" AS ENUM ('local', 'hosted');

-- CreateEnum
CREATE TYPE "dispatch_run_status" AS ENUM ('running', 'succeeded', 'failed', 'cancelled', 'timed_out');

-- CreateEnum
CREATE TYPE "dispatch_stop_reason" AS ENUM ('drained', 'completed', 'max', 'halted', 'interrupted', 'replanned', 'gated', 'abandoned');

-- CreateEnum
CREATE TYPE "dispatch_card_disposition" AS ENUM ('queued', 'running', 'integrated', 'implemented', 'failed', 'replanned', 'skipped', 'not_reached');

-- CreateEnum
CREATE TYPE "dispatch_skip_reason" AS ENUM ('needs_planning', 'needs_human', 'claim_refused', 'blocked_in_scope', 'integrated_dep', 'replan_submitted', 'checkout_unavailable');

-- CreateEnum
CREATE TYPE "dispatch_event_kind" AS ENUM ('run_opened', 'scope_claimed', 'snapshot_frozen', 'session_pr', 'plan_approved', 'run_closed', 'card_claimed', 'card_skipped', 'checkout_ready', 'prompt_issued', 'agent_started', 'agent_exited', 'leg_verdict', 'delivery_linked', 'ci_verdict', 'ci_fix_attempt', 'ci_gave_up', 'card_settled', 'log');

-- CreateTable
CREATE TABLE "dispatch_run" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "command" "dispatch_command" NOT NULL,
    "origin" "dispatch_run_origin" NOT NULL DEFAULT 'local',
    "scope_work_item_id" TEXT,
    "scope_label" TEXT,
    "status" "dispatch_run_status" NOT NULL DEFAULT 'running',
    "stop_reason" "dispatch_stop_reason",
    "agent" TEXT,
    "model" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "created_by_id" TEXT,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dispatch_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatch_run_card" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "dispatch_run_id" TEXT NOT NULL,
    "work_item_id" TEXT,
    "work_item_key" TEXT,
    "position" INTEGER NOT NULL,
    "disposition" "dispatch_card_disposition" NOT NULL DEFAULT 'queued',
    "skip_reason" "dispatch_skip_reason",
    "session_branch" TEXT,
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "exit_code" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dispatch_run_card_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatch_run_event" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "dispatch_run_id" TEXT NOT NULL,
    "dispatch_run_card_id" TEXT,
    "seq" INTEGER NOT NULL,
    "kind" "dispatch_event_kind" NOT NULL,
    "data" JSONB,
    "body" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispatch_run_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dispatch_run_workspace_id_started_at_idx" ON "dispatch_run"("workspace_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "dispatch_run_project_id_started_at_idx" ON "dispatch_run"("project_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "dispatch_run_scope_work_item_id_started_at_idx" ON "dispatch_run"("scope_work_item_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "dispatch_run_status_started_at_idx" ON "dispatch_run"("status", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "dispatch_run_workspace_id_idempotency_key_key" ON "dispatch_run"("workspace_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "dispatch_run_card_dispatch_run_id_position_idx" ON "dispatch_run_card"("dispatch_run_id", "position");

-- CreateIndex
CREATE INDEX "dispatch_run_card_work_item_id_created_at_idx" ON "dispatch_run_card"("work_item_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "dispatch_run_card_workspace_id_idx" ON "dispatch_run_card"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "dispatch_run_card_dispatch_run_id_work_item_id_key" ON "dispatch_run_card"("dispatch_run_id", "work_item_id");

-- CreateIndex
CREATE INDEX "dispatch_run_event_dispatch_run_id_seq_idx" ON "dispatch_run_event"("dispatch_run_id", "seq");

-- CreateIndex
CREATE INDEX "dispatch_run_event_dispatch_run_card_id_seq_idx" ON "dispatch_run_event"("dispatch_run_card_id", "seq");

-- CreateIndex
CREATE INDEX "dispatch_run_event_workspace_id_idx" ON "dispatch_run_event"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "dispatch_run_event_dispatch_run_id_seq_key" ON "dispatch_run_event"("dispatch_run_id", "seq");

-- AddForeignKey
ALTER TABLE "dispatch_run" ADD CONSTRAINT "dispatch_run_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_run" ADD CONSTRAINT "dispatch_run_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_run" ADD CONSTRAINT "dispatch_run_scope_work_item_id_fkey" FOREIGN KEY ("scope_work_item_id") REFERENCES "work_item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_run" ADD CONSTRAINT "dispatch_run_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_run_card" ADD CONSTRAINT "dispatch_run_card_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_run_card" ADD CONSTRAINT "dispatch_run_card_dispatch_run_id_fkey" FOREIGN KEY ("dispatch_run_id") REFERENCES "dispatch_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_run_card" ADD CONSTRAINT "dispatch_run_card_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_run_event" ADD CONSTRAINT "dispatch_run_event_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_run_event" ADD CONSTRAINT "dispatch_run_event_dispatch_run_id_fkey" FOREIGN KEY ("dispatch_run_id") REFERENCES "dispatch_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_run_event" ADD CONSTRAINT "dispatch_run_event_dispatch_run_card_id_fkey" FOREIGN KEY ("dispatch_run_card_id") REFERENCES "dispatch_run_card"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- The SKIP REASON is non-null EXACTLY when the leg was skipped, enforced here
-- rather than left to the service. A skipped leg with no reason is the one row
-- on a run page that says nothing, and the whole argument for giving a skipped
-- card a leg at all is that the reason has nowhere else to live. The constraint
-- is stated in both directions on purpose: a reason on a leg that was NOT
-- skipped is equally wrong, and reads as a skip to anyone scanning the column.
ALTER TABLE "dispatch_run_card"
  ADD CONSTRAINT "dispatch_run_card_skip_reason_iff_skipped"
  CHECK (("disposition" = 'skipped') = ("skip_reason" IS NOT NULL));

-- RLS, in the same migration as the tables (no unguarded window). FORCE so even
-- the table-owner `prodect` role is subject to it — production and the service
-- writes connect as the non-BYPASSRLS `prodect_app` role.
--
-- The gate is each row's OWN `workspace_id`, never a join through
-- `dispatch_run`: RLS does not traverse foreign keys, which is why the two child
-- tables carry a denormalized workspace column at all.
--
-- The workspace RLS migration's `ALTER DEFAULT PRIVILEGES … TO prodect_app`
-- auto-grants on every NEW table created by the `prodect` role, so no explicit
-- GRANT is needed (same as work_item_delivery / work_item_repository / sprint).
ALTER TABLE "dispatch_run" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dispatch_run" FORCE ROW LEVEL SECURITY;

CREATE POLICY "dispatch_run_active_workspace" ON "dispatch_run"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

ALTER TABLE "dispatch_run_card" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dispatch_run_card" FORCE ROW LEVEL SECURITY;

CREATE POLICY "dispatch_run_card_active_workspace" ON "dispatch_run_card"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

ALTER TABLE "dispatch_run_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dispatch_run_event" FORCE ROW LEVEL SECURITY;

CREATE POLICY "dispatch_run_event_active_workspace" ON "dispatch_run_event"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
