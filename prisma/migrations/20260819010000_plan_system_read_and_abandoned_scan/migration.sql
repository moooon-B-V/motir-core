-- CreateIndex
--
-- The ABANDONED-PLAN sweep's discovery read (MOTIR-3064): "which `generating`
-- plans, in ANY project, are older than the grace?" Both existing plan indexes
-- lead with `project_id`, so neither serves a CROSS-WORKSPACE scan. Status first,
-- then age — the order the predicate narrows in.
CREATE INDEX "plan_status_created_at_idx" ON "plan"("status", "created_at");

-- ===========================================================================
-- RLS: add a READ-ONLY `app.system_admin` arm to the plan and plan_item policies
-- (MOTIR-3064 — the abandoned-plan reconciling sweep).
--
-- The 7.21 policies are the PURE workspace gate, and were right: every plan read
-- and write until now happened INSIDE an already-active workspace context, so
-- `app.workspace_id` was always the right key. This sweep changes that premise
-- exactly as MOTIR-916's cadence scan changed `project`'s (20260727225458) and
-- MOTIR-2787's lease sweep changed `plan_target_lock`'s (20260817200000): it is
-- the context-less background runtime those arms exist for, and its FIRST act —
-- "which `generating` plans anywhere have outlived their grace?" — is a
-- cross-workspace discovery scan with no workspace to bind.
--
-- ⚠️ AND WITHOUT AN ARM THAT SCAN IS NOT AN ERROR, IT IS A SILENT ZERO. Under the
-- non-bypass `motir_app` role the workspace predicate compares against an unset
-- GUC, which is NULL, which hides every row — and "no rows" is indistinguishable
-- from "nothing is abandoned". The sweep would pass, green, forever, having
-- reconciled nothing. That is the failure mode the `plan_target_lock` arm's own
-- header names, and it is why the arm ships WITH the sweep rather than after it.
--
-- ⚠️ `plan_item` NEEDS ONE TOO, AND FOR A REASON THAT INVERTS THE USUAL ONE. The
-- sweep's predicate is `status = 'generating' AND source_job_id IS NOT NULL AND
-- NOT EXISTS (its plan_item rows)` — one statement, so the correlated subquery is
-- subject to plan_item's policy in the SAME transaction. With no arm there, every
-- proposal row is hidden, `NOT EXISTS` is vacuously TRUE, and every PARTIAL plan
-- reads as empty. A hidden child does not narrow this scan, it WIDENS it: the
-- blind spot would select exactly the plans MOTIR-3064 AC 5 forbids touching.
-- (The write is still guarded — it re-reads and re-counts under the plan's own
-- workspace context before it acts — but a predicate that is only saved by its
-- guard is a predicate that means something other than what it says.)
--
-- `FOR SELECT` ONLY on both, deliberately narrower than the `attachment` / ledger
-- precedents whose background runtimes write. This one only DISCOVERS under the
-- system context; the terminal status it then writes runs under
-- `withWorkspaceServiceContext` bound to that plan's own workspace, so the
-- pre-existing `*_active_workspace` policies govern every write exactly as
-- before. Leaving `WITH CHECK` untouched means no code path, background or
-- otherwise, can write a plan or a proposal into a workspace that is not the
-- active one.
--
-- Tenant paths are unchanged: requests bind only app.user_id / app.workspace_id /
-- app.project_id via withWorkspaceContext, and `app.system_admin` is bound
-- exclusively by withSystemContext (a constant, never user input — see
-- lib/workspaces/context.ts), so a tenant cannot elevate itself into this branch.
-- ===========================================================================

CREATE POLICY "plan_system_read" ON "plan"
  FOR SELECT
  USING (current_setting('app.system_admin', true) = 'true');

CREATE POLICY "plan_item_system_read" ON "plan_item"
  FOR SELECT
  USING (current_setting('app.system_admin', true) = 'true');
