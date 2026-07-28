-- CreateEnum
CREATE TYPE "plan_origin" AS ENUM ('user', 'cadence');

-- AlterTable
ALTER TABLE "plan" ADD COLUMN     "origin" "plan_origin" NOT NULL DEFAULT 'user';

-- CreateIndex
CREATE INDEX "plan_project_id_status_idx" ON "plan"("project_id", "status");

-- ===========================================================================
-- RLS: add a READ-ONLY `app.system_admin` hatch to the project policy
-- (MOTIR-916 — the auto-plan cadence tick).
--
-- The 1.3.x policy was the PURE workspace gate, and correctly so: every
-- project read/write until now happened INSIDE an already-active workspace
-- context, so `app.workspace_id` was always the right key. The cadence
-- watcher changes that premise the same way the orphan-GC job changed
-- attachment's (20260610160411) and the subscription cron changed
-- saved_filter_subscription's (20260612120420): it is the context-less
-- background runtime those hatches exist for. Its FIRST act — "which projects
-- have `ai_auto_plan_enabled = true`?" — is a CROSS-WORKSPACE discovery scan
-- with no workspace to bind, so under the non-bypass `prodect_app` role it
-- currently sees zero rows and the sweep is dead code.
--
-- DELIBERATELY NARROWER than those precedents: the hatch is added to USING
-- only, NOT to WITH CHECK. Those tables' background runtimes WRITE (the GC
-- deletes; the ledger inserts), so they need the hatch on both. This one only
-- READS projects — everything it does afterwards (the ready count, the
-- pending-plan gate, opening the Plan) runs per project under
-- withWorkspaceContext as that workspace's owner. Leaving WITH CHECK as the
-- pure workspace predicate means no code path, background or otherwise, can
-- INSERT or UPDATE a project into a workspace that is not the active one — the
-- cross-tenant write guard the original policy header called out stays exactly
-- as strong as it was.
--
-- Tenant paths are unchanged: requests bind only app.user_id /
-- app.workspace_id / app.project_id via withWorkspaceContext, and
-- `app.system_admin` is bound exclusively by withSystemContext (a constant,
-- never user input — see lib/workspaces/context.ts), so a tenant cannot
-- elevate itself into this branch.
-- ===========================================================================

DROP POLICY "project_active_workspace" ON "project";

CREATE POLICY "project_workspace_or_system_read" ON "project"
  FOR ALL
  USING (
    "workspaceId" = current_setting('app.workspace_id', true)
    OR current_setting('app.system_admin', true) = 'true'
  )
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));
