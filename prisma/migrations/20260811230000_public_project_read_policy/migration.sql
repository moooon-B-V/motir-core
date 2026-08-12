-- ===========================================================================
-- RLS: give the PUBLIC-project read path an arm to bind against (MOTIR-2684).
--
-- `project` carried exactly ONE policy — `project_workspace_or_system_read`
-- (20260727225458), whose USING is
--     "workspaceId" = current_setting('app.workspace_id', true)
--     OR current_setting('app.system_admin', true) = 'true'
-- and a public read binds NEITHER. The actor may be anonymous (no `app.user_id`)
-- and may be cross-org (no `app.workspace_id` that would match), and the
-- workspace is the PROJECT'S own — which is the very thing the read resolves, so
-- binding it would presume the answer. So under the non-bypass `motir_app` role,
-- and in production after the MOTIR-2515 cutover, EVERY public-project surface
-- 404s for everyone, including a team's own logged-out view of their own project.
--
-- MOTIR-2569 routed the tenant-table reads through `lib/workspaces/tenantRead.ts`
-- and explicitly did not touch policies; this is the one branch of
-- `docs/rls-runtime-role-inventory.md` Finding 4 that a BINDING cannot fix,
-- because there is nothing honest to bind.
--
-- NOT `withSystemContext`. `app.system_admin` is a CROSS-TABLE, CROSS-TENANT flag
-- that `lib/workspaces/context.ts` documents as belonging to the jobs runtime and
-- operator tooling only, never a request path fed user input. Claiming it on
-- behalf of an ANONYMOUS web reader would trade a visible bug for an invisible
-- hole — a widening of the whole database to fix the visibility of one row. The
-- honest fix is to say in the RULE what the product already says in the UI: a
-- project marked `public` is readable.
--
-- ---------------------------------------------------------------------------
-- WHY TWO NEW POLICIES RATHER THAN AN EDIT TO THE EXISTING ONE
-- ---------------------------------------------------------------------------
-- Postgres combines policies as
--     (permissive_1 OR permissive_2 OR ...) AND (restrictive_1 AND ...)
-- per COMMAND. Adding the public arm to `project_workspace_or_system_read`'s
-- USING would have widened that clause for UPDATE and DELETE too — and DELETE has
-- no WITH CHECK to catch it, so an unbound caller could have deleted any public
-- project. A separate `FOR SELECT` permissive policy widens SELECT and only
-- SELECT: the FOR-ALL policy still governs the write commands unchanged, so
--   * `WITH CHECK` is untouched — no path can INSERT or UPDATE a project into a
--     workspace that is not the active one, exactly as strong as before; and
--   * an unbound DELETE still matches zero rows.
-- Both directions are pinned in `tests/permissions/publicProjectAccess.test.ts`.
--
-- Tenant paths are unaffected: a bound request already passed the workspace arm,
-- so the visible set for a normal tenant read does not change.
-- ===========================================================================

CREATE POLICY "project_public_read" ON "project"
  FOR SELECT
  USING ("accessLevel" = 'public');

-- ===========================================================================
-- work_item: the same arm, one table over — and DELIBERATELY NARROWER.
--
-- Resolving the project is only half the path. Every public surface — the board,
-- the roadmap, the work-items tab, the tree, and `publicRequestsService`'s
-- `resolvePublicRequest` (which opens with an unbound `work_item` read, BEFORE
-- the grant check it exists to run) — then reads `work_item` on the same
-- context-less connection. With the project arm alone the project resolves and
-- every one of those surfaces hands back an EMPTY board: the 404 becomes a blank
-- page, which is not a fix. A public request cannot even be upvoted, because the
-- item read fails before the grant is consulted.
--
-- Two differences from the project policy above, both load-bearing:
--
-- 1. Publicness is INHERITED here, not a column — it lives on the parent project
--    — so the predicate is a join, and `work_item` is the product's hottest
--    table. A bare `EXISTS (...)` OR'd into every SELECT's qual would put a
--    correlated subquery in the path of every tenant read and can cost the
--    planner its `workspaceId` index path.
--
-- 2. So the arm is GATED on there being no bound workspace at all. It fires only
--    on the genuinely context-less connection, which is precisely and only the
--    public path.
--
--    MEASURED rather than assumed, on 500 work items (PG 15, `EXPLAIN ANALYZE`):
--    with `app.workspace_id` bound, the planner keeps the same access path (the
--    `work_item_projectId_*` index scan when selective) and reports the project
--    lookup as `SubPlan 2 -> Seq Scan on project p (never executed)` — the AND
--    short-circuits on the row-independent GUC test, so the join is not entered
--    once across all 500 rows. Unbound, the same subplan runs `loops=1`: Postgres
--    HASHES it, so it is one lookup per QUERY, not per row. The qual text does
--    grow by the disjunct; the work does not.
--
-- The gate also keeps the widening minimal in the other sense: a tenant session
-- does not gain sight of another workspace's public items, only an unbound
-- reader does.
--
-- The EXISTS is itself subject to `project`'s policies (a subquery in a policy
-- runs under the querying role), so it resolves through `project_public_read`
-- above — a work item is visible unbound exactly when its project is. The two
-- policies cannot drift apart.
--
-- FOR SELECT only, for the same reason as above: writes stay governed by
-- `work_item_active_workspace`'s USING + WITH CHECK, and the restrictive
-- `work_item_project_narrow` still AND's on top of the read (its
-- `coalesce(app.project_id, '') = ''` branch is what lets an unbound public read
-- through, unchanged).
-- ===========================================================================

CREATE POLICY "work_item_public_project_read" ON "work_item"
  FOR SELECT
  USING (
    coalesce(current_setting('app.workspace_id', true), '') = ''
    AND EXISTS (
      SELECT 1
      FROM "project" p
      WHERE p."id" = "work_item"."projectId"
        AND p."accessLevel" = 'public'
    )
  );
