-- ROW-LEVEL SECURITY FOR AN ORG-OWNED REPOSITORY
-- Story MOTIR-4669 · subtask MOTIR-4677.
--
-- MOTIR-4649 put `organization_id` on `github_repo`. This is the half that reads
-- it. A repository is connected ONCE, to the ORGANISATION, and which projects use
-- it is visibility configuration — so a `project_repository` row in workspace W2
-- referencing a repository connected from W1 must RESOLVE. Under the shipped
-- policy it does not: `github_repo_workspace_or_system` predicates every read on
-- `workspace_id = app.workspace_id`, so the join returns nothing and the surface
-- renders a repository that is not there.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠️ THE SHAPE: A SEPARATE `FOR SELECT` POLICY, NOT A WIDENED `FOR ALL`.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- This is the one decision in the migration that a reader must not have to
-- re-derive, because getting it wrong is silent and severe.
--
-- The existing policies are `FOR ALL`, with the same expression in `USING` and
-- `WITH CHECK`. Widening that `USING` in place would look like a read-only
-- change and would not be one: **`DELETE` is authorised by `USING` alone.** A
-- `FOR ALL` policy whose `USING` admits every workspace of the organisation
-- therefore lets W2 DELETE a repository row connected from W1 — and `UPDATE`
-- would be able to SELECT it too, failing only at the `WITH CHECK`.
--
-- So the existing `FOR ALL` policies are left EXACTLY as they are — nothing
-- admitted before this migration is admitted less after it — and the org reach is
-- added as separate `FOR SELECT` policies. Permissive policies OR-combine, so a
-- SELECT sees both arms while INSERT / UPDATE / DELETE keep only the narrow one.
-- That is the same instrument, and the same reasoning, as
-- `20260826001500_workspace_org_member_read_arm` ("⚠️ WHY `FOR SELECT` AND
-- NOTHING ELSE"): reading which repositories your organisation has and being
-- allowed to delete one are different powers.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- HOW THE ORGANISATION IS RESOLVED — from the ACTIVE WORKSPACE, plus the org GUC
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `withWorkspaceContext` binds `app.user_id`, `app.workspace_id` and
-- `app.project_id` — and NOT `app.organization_id` (`lib/workspaces/context.ts`).
-- A policy that only compared `organization_id` to that GUC would therefore admit
-- nothing on the ordinary request path, which is every path this story is about.
-- So the arm DERIVES the organisation from the bound workspace, and additionally
-- honours the org GUC for the `withOrgContext` readers that do bind one.
--
-- ⚠️ THE SUBQUERY IS REACHABLE, which is not automatic: `workspace` is itself
-- RLS-enabled and a policy's `USING` is evaluated with the querying role's own
-- policies applied to any table it reads. It resolves because `workspace_active`
-- admits `id = current_setting('app.workspace_id')` — exactly the row read here.
-- The precedent above relies on the identical property for
-- `organization_membership`.
--
-- FAILS CLOSED on every unbound axis, the house pattern: with nothing bound,
-- `current_setting(..., true)` is NULL, every comparison is NULL, the EXISTS
-- matches no row, and the row is refused. A NULL `organization_id` is refused for
-- the same reason (`NULL = NULL` is NULL), so a row the backfill has not reached
-- is invisible rather than public — the safe direction.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE TWO POLICIES THAT KEY THROUGH THE REPOSITORY — a disposition each
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `github_pull_request_workspace_or_system` — **ARM ADDED.** A repository shared
--   into W2's project renders its pull requests on W2's work items (the
--   Development surface, the delivery set, the completion gate). Leaving this
--   workspace-scoped would ship a model in which the repository is visible and
--   its pull requests are not — a half-delivered story whose symptom is an empty
--   panel nobody can explain. The widening is READ-only and bounded by the same
--   organisation the repository arm establishes.
--
-- `github_check_run_workspace_or_system` — **ARM ADDED**, for the same reason one
--   hop further out: a pull request the reader can see whose CI verdict they
--   cannot is the same defect wearing a different panel. Its predicate already
--   joins through `github_pull_request` → `github_repo`, so the arm is the same
--   condition on the same repository row.
--
-- Neither is RE-PREDICATED: both keep their existing `FOR ALL` policy untouched,
-- for the DELETE reason above, and gain a `FOR SELECT` sibling.
--
-- `github_installation`'s own policy is deliberately NOT touched, and its
-- disposition is the one the 2026-07-31 migration already recorded: the shared
-- provisioning row's `workspace_id` is NULL, so it is invisible to every tenant
-- read and visible only under the system escape. `organization_id` is NULL on
-- that same row for the same reason (MOTIR-4649), so adding an org arm there
-- would admit nothing and would suggest it might.

-- ---------------------------------------------------------------------------
-- 1 · github_repo — the organisation's repositories are READABLE
-- ---------------------------------------------------------------------------
CREATE POLICY "github_repo_org_read" ON "github_repo"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "workspace" w
      WHERE w."id" = current_setting('app.workspace_id', true)
        AND w."organizationId" = "github_repo"."organization_id"
    )
    OR "organization_id" = current_setting('app.organization_id', true)
  );

-- ---------------------------------------------------------------------------
-- 2 · github_pull_request — one hop through the repository
-- ---------------------------------------------------------------------------
CREATE POLICY "github_pull_request_org_read" ON "github_pull_request"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "github_repo" r
      WHERE r."id" = "github_pull_request"."repo_id"
        AND (
          EXISTS (
            SELECT 1 FROM "workspace" w
            WHERE w."id" = current_setting('app.workspace_id', true)
              AND w."organizationId" = r."organization_id"
          )
          OR r."organization_id" = current_setting('app.organization_id', true)
        )
    )
  );

-- ---------------------------------------------------------------------------
-- 3 · github_check_run — two hops, the same condition on the same repository row
-- ---------------------------------------------------------------------------
CREATE POLICY "github_check_run_org_read" ON "github_check_run"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "github_pull_request" p
      JOIN "github_repo" r ON r."id" = p."repo_id"
      WHERE p."id" = "github_check_run"."pull_request_id"
        AND (
          EXISTS (
            SELECT 1 FROM "workspace" w
            WHERE w."id" = current_setting('app.workspace_id', true)
              AND w."organizationId" = r."organization_id"
          )
          OR r."organization_id" = current_setting('app.organization_id', true)
        )
    )
  );
