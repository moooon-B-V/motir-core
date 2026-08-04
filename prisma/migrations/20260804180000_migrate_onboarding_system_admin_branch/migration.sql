-- ===========================================================================
-- migrate_onboarding — give the RLS policy a system-admin branch (MOTIR-2082)
-- ===========================================================================
-- WHY THIS EXISTS. A migrate-onboarding run parks at the `index` step until
-- something evaluates that step's exit condition, and until now the ONLY
-- callers were the wizard client and its `index-status` poll — both in the
-- browser. Close the tab before the code-graph index finishes and the run sits
-- `active` at `index` forever, even once the ledger says the index succeeded.
-- MOTIR-2082 fixes that with a scheduled cross-workspace SWEEP that re-evaluates
-- the exit condition from durable state.
--
-- The sweep's discovery read — "which runs, in ANY workspace, are active at
-- `index`?" — is the one read that has no workspace to bind: it is the query
-- that FINDS the workspaces. That is exactly the `withSystemContext` shape the
-- auto-plan cadence tick (MOTIR-916) and the filter-subscription tick use for
-- their phase-1 scans.
--
-- But `migrate_onboarding` was created (20260710042507) as a deliberately pure
-- workspace gate — its comment says "no escape hatch" — so under
-- `withSystemContext` (which binds `app.system_admin` and NOT `app.workspace_id`)
-- the USING predicate evaluates `workspace_id = NULL` → NULL → every row hidden.
-- The sweep would scan zero rows and silently repair nothing: a passing job that
-- never does its job. This migration adds the branch the scan needs.
--
-- SCOPE OF THE WIDENING — read branch only, in practice. This is the SAME
-- `system_admin OR workspace_id` policy job_run / github_repo / attachment and
-- friends already carry (20260602013718 is the canonical shape). It does NOT
-- widen any tenant path: `app.system_admin` is bound ONLY by
-- `withSystemContext`, an internal server helper that binds a CONSTANT and is
-- never fed user input (see lib/workspaces/context.ts). A tenant request runs
-- under `withWorkspaceContext`, where the GUC is unset, so a workspace member's
-- reach through this policy is byte-for-byte what it was before.
--
-- The sweep itself deliberately does NOT write under this branch: it discovers
-- under `withSystemContext`, then commits each run's advance under
-- `withWorkspaceServiceContext(run.workspaceId)` — the workspace-tier context
-- that binds only `app.workspace_id`. So the cross-tenant reach is exactly one
-- bounded, READ-ONLY scan, and every mutation stays row-scoped to the tenant
-- that owns the run, enforced by RLS rather than by care in the service.
--
-- ENABLE + FORCE are already set on the table and are not repeated here.
-- ===========================================================================
DROP POLICY "migrate_onboarding_active_workspace" ON "migrate_onboarding";

CREATE POLICY "migrate_onboarding_workspace_or_system_admin" ON "migrate_onboarding"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  );
