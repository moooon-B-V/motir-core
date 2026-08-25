-- The Postgres job engine's three tables (Story MOTIR-3414 · Subtask MOTIR-3420).
--
-- `job_event` (the emitted event log a dispatcher fans out from), `job_queue`
-- (one row per RUN — what a worker claims), and `job_step` (memoized step
-- results keyed `(run_id, step_id)`), each with its RLS policy IN THIS SAME
-- MIGRATION — the "table + its policy in one migration, no unguarded window"
-- invariant (PRODECT_FINDINGS #20).
--
-- ===========================================================================
-- Why these tables are OURS and live in `public`
-- ===========================================================================
-- `docs/decisions/job-queue-foundation.md` (MOTIR-3419) chose a hand-rolled
-- queue over Graphile Worker and pg-boss, and THIS MIGRATION is the concrete
-- reason. Both libraries create and own their tables in their own Postgres
-- schema (`graphile_worker` / `pgboss`), and every grant this database issues
-- is scoped `IN SCHEMA public`:
--
--   GRANT USAGE ON SCHEMA public TO motir_app;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT … ON TABLES TO motir_app;
--
-- (20260810000000_rename_app_role_to_motir_app). `motir_app` is NOBYPASSRLS and
-- is what production connects as, so a library's schema would be unreadable to
-- the runtime role AND unreachable by the policies below. Three tables in
-- `public`, created by the migration-running role, inherit both for free.
--
-- ===========================================================================
-- This migration is ADDITIVE — it changes no behaviour
-- ===========================================================================
-- Nothing writes to these tables yet. The worker (MOTIR-3421), the step shim
-- (MOTIR-3422) and the dispatcher + cutover switch (MOTIR-3423) land next, and
-- until a job id is explicitly moved onto the new lane every one of the 24 job
-- definitions still runs on Inngest. `job_run` / `job_run_dlq` — the operator
-- ledger — are untouched.
--
-- ===========================================================================
-- The claim index, and the partial index deliberately NOT written
-- ===========================================================================
-- The worker claims with
--
--   SELECT … FROM job_queue
--    WHERE state = 'pending' AND run_at <= now()
--    ORDER BY run_at
--    FOR UPDATE SKIP LOCKED LIMIT n
--
-- so `job_queue_state_run_at_idx` is `(state, run_at)` — the equality column
-- first, then the column the query both ranges over and orders by, which lets
-- Postgres seek to the first due row and walk forward with no sort step. The
-- lease-reclaim sweep (`state = 'running' AND lease_expires_at < now()`) gets
-- its own `(state, lease_expires_at)`.
--
-- ⚠️ A PARTIAL index — `ON job_queue(run_at) WHERE state = 'pending'` — would be
-- tighter and is deliberately NOT written. `CLAUDE.md` § Migrations records why:
-- Prisma's differ pairs indexes BY COLUMN LIST and cannot express a WHERE
-- clause, so a partial index whose columns are claimed by an `@@index` on the
-- same model is reported as a permanent spurious RENAME, which the next
-- `migrate dev` writes into a migration and which renames one index over the
-- other. Both index sets here come from `@@index` entries in `schema.prisma`,
-- so the datamodel and the database cannot disagree and the class cannot fire.
--
-- ===========================================================================
-- `(event_id, job_id)` UNIQUE — fan-out idempotency, and the NULL that matters
-- ===========================================================================
-- One run per (event, job) is what makes a retrying dispatcher unable to
-- double-enqueue (consumed by MOTIR-3423). A CRON run has no triggering event
-- and carries `event_id IS NULL`; Postgres treats NULL as distinct from every
-- other NULL in a unique index, so scheduled runs are not constrained by it.
-- That is the intended reading, not an accident of nullability: two ticks of the
-- same cron are two runs and must both exist.
--
-- ===========================================================================
-- Row-level security — the `job_run` / `job_run_dlq` pattern, and NULL tenancy
-- ===========================================================================
-- Same shape as 20260602013718_add_job_run_dlq_and_rls, for the same reason: the
-- WRITER is the background-jobs runtime, which runs OUTSIDE any HTTP request and
-- has no active workspace context — a job may process an event for any
-- workspace, or for none.
--
--   * ENABLE + FORCE, so even the owning role is subject to the policy. FORCE
--     does not defeat BYPASSRLS on a superuser, which is why production connects
--     as the non-bypass `motir_app` role.
--   * A single PERMISSIVE `FOR ALL` policy carrying the same predicate in USING
--     and WITH CHECK — which is also what satisfies the four-verb totality guard
--     in `tests/tenant-root-creation-rls.test.ts`.
--   * `current_setting('<key>', true)` — the `true` is missing_ok, so an unset
--     GUC yields NULL, the predicate evaluates to NULL, and the row is HIDDEN.
--     No context ⇒ nothing visible.
--
-- ⚠️ HOW `workspace_id IS NULL` IS HANDLED, stated rather than assumed. A system
-- job's rows are untenanted, and `NULL = current_setting(...)` is NULL, not
-- true — so an untenanted row is invisible to EVERY tenant context. That is the
-- correct and intended outcome: a workspace member must never see system-job
-- rows. Those rows are reached exclusively through the system-admin branch,
-- which the trusted writer binds via `withSystemContext`
-- (`lib/workspaces/context.ts`) and which no tenant can set — `app.system_admin`
-- is bound only by that internal helper and is never fed user input. So the
-- nullable column is not a gap in the policy; the system-admin branch IS the
-- policy's answer to it, exactly as it is for `job_run`.
--
-- ⚠️ AND `job_step.workspace_id` IS DENORMALISED from its run, deliberately. The
-- alternative — an EXISTS subquery onto `job_queue` — would put a join in the
-- hottest path the engine has (`step.run` probes `(run_id, step_id)` once per
-- step, per attempt) and would make the step ledger's tenancy depend on its
-- parent row still existing. Carrying the column keeps all three predicates
-- identical and the probe a single index seek. The shim copies it from the run
-- at insert; the FK to `workspace` cascades, exactly as the run's does.
--
-- Grants: `ALTER DEFAULT PRIVILEGES IN SCHEMA public … TO motir_app` makes every
-- new table created by the migration-running role grantable without an explicit
-- GRANT here — the same inheritance `job_run` and `job_run_dlq` rely on.

-- CreateEnum
CREATE TYPE "job_run_state" AS ENUM ('pending', 'running', 'succeeded', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "job_step_kind" AS ENUM ('run', 'sleep');

-- CreateTable
CREATE TABLE "job_event" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "workspace_id" TEXT,
    "idempotency_key" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_queue" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "event_id" TEXT,
    "event_name" TEXT NOT NULL,
    "workspace_id" TEXT,
    "run_at" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL,
    "state" "job_run_state" NOT NULL DEFAULT 'pending',
    "claimed_by" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "last_error" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_step" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "step_id" TEXT NOT NULL,
    "kind" "job_step_kind" NOT NULL DEFAULT 'run',
    "result" JSONB,
    "sleep_until" TIMESTAMP(3),
    "workspace_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_step_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "job_event_workspace_id_received_at_idx" ON "job_event"("workspace_id", "received_at" DESC);

-- CreateIndex
CREATE INDEX "job_event_idempotency_key_idx" ON "job_event"("idempotency_key");

-- CreateIndex
CREATE INDEX "job_queue_state_run_at_idx" ON "job_queue"("state", "run_at");

-- CreateIndex
CREATE INDEX "job_queue_state_lease_expires_at_idx" ON "job_queue"("state", "lease_expires_at");

-- CreateIndex
CREATE INDEX "job_queue_workspace_id_created_at_idx" ON "job_queue"("workspace_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "job_queue_event_id_job_id_key" ON "job_queue"("event_id", "job_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_step_run_id_step_id_key" ON "job_step"("run_id", "step_id");

-- AddForeignKey
ALTER TABLE "job_event" ADD CONSTRAINT "job_event_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_queue" ADD CONSTRAINT "job_queue_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "job_event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_queue" ADD CONSTRAINT "job_queue_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_step" ADD CONSTRAINT "job_step_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "job_queue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_step" ADD CONSTRAINT "job_step_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security — job_event, job_queue, job_step
-- ===========================================================================
ALTER TABLE "job_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job_event" FORCE ROW LEVEL SECURITY;

ALTER TABLE "job_queue" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job_queue" FORCE ROW LEVEL SECURITY;

ALTER TABLE "job_step" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job_step" FORCE ROW LEVEL SECURITY;

-- job_event: a tenant sees its own workspace's events; the trusted writer and
-- operator tooling reach every row (including the untenanted system ones)
-- through the system-admin branch. USING governs the tenant SELECT; WITH CHECK
-- lets the dispatcher's INSERT land under the non-bypass role.
CREATE POLICY "job_event_workspace_or_system_admin" ON "job_event"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  );

-- job_queue: identical gate. The worker claims and updates these rows under the
-- system-admin context; a workspace member reading the operator dashboard sees
-- only their own workspace's runs.
CREATE POLICY "job_queue_workspace_or_system_admin" ON "job_queue"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  );

-- job_step: identical gate over the denormalised column (see the header). A
-- step's stored result is tenant data — it is whatever the handler returned —
-- so it is guarded exactly as the run that produced it is.
CREATE POLICY "job_step_workspace_or_system_admin" ON "job_step"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  );
