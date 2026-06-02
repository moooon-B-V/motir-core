-- Dead-letter queue + row-level security for the background-jobs ledger
-- (Story 1.6 · Subtask 1.6.4). This migration ships THREE things in one atomic
-- step (migration-by-concern, PRODECT_FINDINGS #20):
--   1. the `job_run_dlq` table + its index + FK, and
--   2. ENABLE/FORCE row-level security on BOTH `job_run` (created unguarded in
--      1.6.2, RLS deliberately deferred to here) and the new `job_run_dlq`, and
--   3. the tenancy policy on each table.
--
-- 1.6.2's add_job_runs migration deferred job_run's RLS to this Subtask on
-- purpose: the policy needed the system-admin escape hatch that only makes
-- sense once the DLQ + replay surfaces exist, and batching both tables' policies
-- here keeps the "table + its policy in one migration" invariant for job_run_dlq
-- while closing job_run's gap in the same breath. Until now job_run was reached
-- ONLY through the trusted server-side wrapper, never a tenant-facing query path,
-- so the unguarded window carried no real exposure.
--
-- ===========================================================================
-- The trusted-writer / tenant-reader split — why a system-admin escape hatch
-- ===========================================================================
-- job_run / job_run_dlq are unlike project / work_item: their WRITER is the
-- background-jobs runtime (defineJob → jobRunsService), which runs OUTSIDE any
-- HTTP request and therefore has NO active workspace context — a job may
-- process an event for any workspace, or for none (system / cross-workspace
-- email). A purely workspace-scoped WITH CHECK (like project's) would reject
-- the wrapper's own inserts under the non-bypass prodect_app role, because
-- app.workspace_id is unset at write time.
--
-- So the policy carries a system-admin branch: when `app.system_admin = 'true'`
-- the row passes regardless of workspace_id. The trusted writer sets that GUC
-- (lib/workspaces/context.ts · withSystemContext, used by jobRunsService), so
-- its writes — tenanted or untenanted — succeed. The same branch is the
-- "cross-workspace admin tooling" escape hatch the 1.6.5 dashboard uses to show
-- SYSTEM rows (workspace_id IS NULL): an operator with the system-admin context
-- sees every row; a normal tenant context sees only its own workspace's rows
-- and never the untenanted system rows.
--
-- TENANT READ PATH: the dashboard reads under withWorkspaceContext (app.user_id
-- + app.workspace_id set, system_admin UNSET) — so a workspace member sees only
-- their workspace's runs, exactly mirroring the Story 1.2 workspace-scope
-- pattern. A tenant CANNOT set app.system_admin: that GUC is bound only by
-- withSystemContext, an internal server helper never fed user input.
--
-- Policy shape otherwise mirrors add_project_rls / add_work_item_rls:
--   * ENABLE + FORCE so even the table-owner role (`prodect`) is subject to the
--     policy. FORCE does NOT defeat BYPASSRLS on the superuser — that's why
--     production connects as the non-bypass prodect_app role (PRODECT_FINDINGS
--     #5), and why the RLS tests drop to that role.
--   * `current_setting('<key>', true)` — the `true` is missing_ok, so an unset
--     GUC yields NULL → the predicate evaluates to NULL → row hidden. Safe
--     failure mode (no context → nothing visible).
--   * FOR ALL on a single permissive policy: the system-admin branch covers the
--     writer's INSERT/UPDATE (WITH CHECK), and the workspace branch covers the
--     tenant SELECT. Both USING and WITH CHECK carry the same predicate.
--
-- Grants: the workspace RLS migration's `ALTER DEFAULT PRIVILEGES IN SCHEMA
-- public ... TO prodect_app` makes every NEW table created by the `prodect`
-- role auto-grantable. `job_run` (20260601225436) and `job_run_dlq` (this
-- migration) were both created by that role, so SELECT/INSERT/UPDATE/DELETE are
-- already in place for prodect_app. No explicit GRANT needed.

-- CreateTable
CREATE TABLE "job_run_dlq" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "function_id" TEXT NOT NULL,
    "event_name" TEXT NOT NULL,
    "event_data" JSONB NOT NULL,
    "failure" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL,
    "first_failed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_failed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "replayed_at" TIMESTAMP(3),

    CONSTRAINT "job_run_dlq_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "job_run_dlq_workspace_id_last_failed_at_idx" ON "job_run_dlq"("workspace_id", "last_failed_at" DESC);

-- AddForeignKey
ALTER TABLE "job_run_dlq" ADD CONSTRAINT "job_run_dlq_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security — job_run (deferred from 1.6.2) + job_run_dlq
-- ===========================================================================
ALTER TABLE "job_run" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job_run" FORCE ROW LEVEL SECURITY;

ALTER TABLE "job_run_dlq" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job_run_dlq" FORCE ROW LEVEL SECURITY;

-- job_run: tenant rows visible/mutable when they belong to the active
-- workspace; the system-admin branch lets the trusted writer (and operator
-- tooling) act on any/untenanted row. USING governs the tenant SELECT;
-- WITH CHECK lets the wrapper's INSERT/UPDATE land under the non-bypass role.
CREATE POLICY "job_run_workspace_or_system_admin" ON "job_run"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  );

-- job_run_dlq: identical gate. The DLQ row is written by the same trusted
-- wrapper transaction (under system-admin context) and read by the same
-- tenant/operator surfaces.
CREATE POLICY "job_run_dlq_workspace_or_system_admin" ON "job_run_dlq"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  );
