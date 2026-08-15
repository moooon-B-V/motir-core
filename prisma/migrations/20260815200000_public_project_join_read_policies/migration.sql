-- ===========================================================================
-- RLS: the three JOINED tables the public read path still cannot see
-- (MOTIR-2856) — `workflow_status`, `workspace`, `organization`.
--
-- 20260811230000 armed `project` + `work_item`; 20260813210000 armed
-- `public_request_vote`. Each was traced back from a surface that was visibly
-- broken. Nobody traced the SECOND HOP, so four public reads still return ZERO
-- ROWS — and raise nothing — under the non-bypass `motir_app` role:
--
--   read                                            | joins           | blocked by
--   ------------------------------------------------+-----------------+------------------------
--   workItemRepository#findPublicRoadmapSubmitted    | workflow_status | workflow_status
--   workItemRepository#countPublicRoadmapSubmitted   | workflow_status | workflow_status
--   workItemRepository#findPublicRequestMatches      | workflow_status | workflow_status
--   projectRepository#listPublicDirectoryRanked      | workspace → org | workspace, organization
--
-- Measured against the migrated database as `motir_app` with NO GUC bound —
-- the exact connection state a public request arrives in:
--
--   tbl                 | rls | public_arms | total_policies
--   --------------------+-----+-------------+---------------
--   organization        | t   |           0 |              6
--   workflow_status     | t   |           0 |              1
--   workspace           | t   |           0 |              6
--
-- THE REQUEST PATH REALLY IS THAT CONNECTION, verified rather than assumed:
-- `publicProjectsService` and `projectSquareService` reach all four reads on the
-- `@/lib/db` singleton with no surrounding context transaction, so no
-- `app.workspace_id` is ever bound. The one context helper either service uses,
-- `withSystemContext`, binds `app.system_admin` ALONE (lib/workspaces/context.ts
-- — it sets that GUC and nothing else), so it does not disturb the gate below.
--
-- This is a PRODUCTION defect, latent only because production still connects as
-- a BYPASSRLS owner. At the MOTIR-2515 cutover the roadmap's Submitted column,
-- its header count, the duplicate-detection pre-check, and the whole project
-- square go blank at once, for every reader — including a team's own logged-out
-- view of their own project. A zero-row read raises nothing, so the first report
-- will be a customer saying the page is empty, not an exception in a log.
--
-- ---------------------------------------------------------------------------
-- THE SHAPE THE THREE ARMS SHARE
-- ---------------------------------------------------------------------------
-- Each mirrors `work_item_public_project_read` on both of that policy's
-- load-bearing properties:
--
--   * FOR SELECT ONLY. Postgres combines policies as
--     (permissive_1 OR permissive_2 OR …) AND (restrictive_1 AND …) PER COMMAND.
--     A separate SELECT policy therefore widens reads and only reads: each
--     table's existing write policies keep governing INSERT / UPDATE / DELETE
--     unchanged, and no `WITH CHECK` is touched. The per-table sections below
--     name the exact inventory left in place. DELETE deserves the explicit note
--     the `project` arm made, because DELETE has no `WITH CHECK` to catch a
--     widened `USING` — had these been FOR ALL rather than FOR SELECT, an
--     unbound caller could have deleted the very rows it can now read. Both
--     directions are pinned in `tests/permissions/publicProjectAccess.test.ts`.
--
--   * GATED ON THERE BEING NO BOUND WORKSPACE. `coalesce(current_setting(
--     'app.workspace_id', true), '') = ''` is row-INDEPENDENT, so a bound
--     session short-circuits the AND before the EXISTS is entered — measured per
--     table below, and `never executed` on all three. A tenant session gains
--     exactly nothing: it keeps the visible set it had. The arm fires only on
--     the genuinely context-less connection, which is precisely and only the
--     public path.
--
-- Each EXISTS is itself subject to the policies of the tables it reads (a
-- subquery in a policy runs under the querying role), so it resolves through
-- `project_public_read` — a row is visible unbound exactly when a `public`
-- project vouches for it, and these arms cannot drift away from that one.
-- `project_public_read`'s USING is a bare column test with no subquery, so the
-- chain terminates and no policy recursion is possible.
--
-- NOT `withSystemContext`, for the reason 20260811230000 argues at length:
-- `app.system_admin` is a cross-table, cross-tenant flag documented as belonging
-- to the jobs runtime and operator tooling. Claiming it for an anonymous web
-- reader trades a visible bug for an invisible hole.
--
-- ---------------------------------------------------------------------------
-- ⚠️ WHAT THIS WIDENS THAT THE SQUARE DOES NOT PROJECT — stated, not buried
-- ---------------------------------------------------------------------------
-- RLS is ROW-level. `listPublicDirectoryRanked` projects only `o."name"` and
-- `o."slug"`, but a policy cannot admit two columns — it admits the ROW. So an
-- unbound `SELECT *` over `organization` would now also return
-- `scaledTrackerSubscription`, `aiIncludedSeat` and `isMeta` for an org that
-- owns a public project, and over `workspace`, `subtaskPrMergeMode`. That is a
-- real consequence and it is accepted here for three reasons: no unbound query
-- in the codebase selects those columns (the two public services read through
-- the two repositories above, whose projections are explicit); RLS is the SECOND
-- line here, behind the services' own `accessLevel = 'public'` filters; and the
-- alternative — routing the org name through a SECURITY DEFINER view — adds a
-- bypass surface strictly harder to reason about than a row whose name and slug
-- the product already publishes. Column-level narrowing, if it is ever wanted,
-- is a GRANT question and not a policy one.
--
-- ---------------------------------------------------------------------------
-- ⚠️ THE MEASUREMENT THAT CHANGED THE ANSWER — read it before "optimising" the
--    organization arm into a hashable form
-- ---------------------------------------------------------------------------
-- `work_item`'s arm reports its subplan as `hashed SubPlan` — one lookup per
-- QUERY. None of these three do: each correlates on the outer row, so Postgres
-- re-executes the subplan per admitted row. That looks like the thing to fix,
-- and the obvious fix is to make the predicate uncorrelated so it hashes:
--
--     "organization"."id" IN (SELECT w."organizationId"
--                               FROM "project" p
--                               JOIN "workspace" w ON w."id" = p."workspaceId"
--                              WHERE p."accessLevel" = 'public')
--
-- IT IS SLOWER, AND MEASURABLY SO. A/B on the square's own join, 2 000 tenants /
-- 1 000 public projects, three runs each, `EXPLAIN ANALYZE` under `motir_app`
-- with nothing bound:
--
--     EXISTS (correlated, shipped)  0.594 / 0.498 / 0.523 ms
--     IN     (uncorrelated, hashed) 4.247 / 4.578 / 3.664 ms      ~8× worse
--
-- The reason is the outer `LIMIT`. The square reads one page — 25 cards — so the
-- correlated form runs 25 primary-key index lookups (`loops=25`) and stops. The
-- hashed form has to MATERIALISE THE WHOLE PUBLIC SET to build its hash — the
-- plan shows `Nested Loop (actual rows=1000)` — before a single card is
-- returned, and it pays that whether the page is 25 rows or 1. A per-row subplan
-- bounded by a small LIMIT beats a per-query subplan over the entire table, and
-- "hashed is cheaper" is the intuition to distrust here.
-- ===========================================================================

-- ===========================================================================
-- workflow_status — the roadmap's category filter.
--
-- Three of the four blocked reads join it for one predicate,
-- `ws."category" <> 'done'`, on `ws."project_id" = w."projectId" AND ws."key" =
-- w."status"`. It is the tightest of the three arms: the table carries a
-- NON-NULL `project_id`, so publicness is one hop away and the EXISTS is a
-- primary-key lookup on `project`.
--
-- Existing policy inventory: exactly ONE, `workflow_status_active_workspace`
-- (20260602120000), `FOR ALL USING/WITH CHECK ("workspace_id" = GUC)`. It is
-- therefore the sole governor of INSERT / UPDATE / DELETE both before and after
-- this migration; the arm below adds a second permissive SELECT policy and
-- nothing else. FOR SELECT is what keeps that true, and it matters concretely
-- here: a workflow status is project CONFIGURATION, so an unbound writer able to
-- add or retitle one on a public project could edit a team's board.
--
-- MEASURED (PG 15, `EXPLAIN ANALYZE (COSTS OFF, TIMING OFF)`, 14 000 statuses
-- across 2 000 projects), reading one project's statuses:
--
--   BOUND (app.workspace_id set) — 0.087 ms
--     Bitmap Heap Scan on workflow_status (actual rows=7 loops=1)
--       ->  Bitmap Index Scan on workflow_status_project_id_key_key (rows=7)
--       SubPlan 1
--         ->  Index Scan using project_pkey on project p (never executed)
--
--   UNBOUND — 0.136 ms
--     …same access path…
--       SubPlan 1
--         ->  Index Scan using project_pkey on project p (actual rows=1 loops=7)
--
-- Two things to read off it. The bound session keeps the SAME index path it had
-- and never enters the join — `never executed`, across all 7 rows. And unbound,
-- the subplan is a primary-key lookup run once per ADMITTED row (loops=7, not
-- per table row), because these reads are already narrowed to one project.
-- ===========================================================================

CREATE POLICY "workflow_status_public_project_read" ON "workflow_status"
  FOR SELECT
  USING (
    coalesce(current_setting('app.workspace_id', true), '') = ''
    AND EXISTS (
      SELECT 1
      FROM "project" p
      WHERE p."id" = "workflow_status"."project_id"
        AND p."accessLevel" = 'public'
    )
  );

-- ===========================================================================
-- workspace — the first hop of the project square's org join.
--
-- `listPublicDirectoryRanked` reads
--     FROM "project" p
--     JOIN "workspace" w ON w."id" = p."workspaceId"
--     JOIN "organization" o ON o."id" = w."organizationId"
-- to put the owning org's name and slug on every card. The workspace row is a
-- pure HOP — not one of its columns reaches the DTO — but an invisible row still
-- kills the join, so the square renders empty for everyone.
--
-- ⚠️ THE PREDICATE POINTS THE OTHER WAY FROM `work_item`'s, and that is the part
-- not to copy blind. `work_item` and `workflow_status` sit BELOW `project` and
-- each carries a `projectId`, so their EXISTS is a lookup: one row, by primary
-- key. `workspace` sits ABOVE it. The honest predicate is therefore "this
-- workspace HAS a public project" — `p."workspaceId" = "workspace"."id"` — a
-- semi-join over `project` satisfied by ANY ONE of the workspace's projects,
-- which is a different shape and was measured rather than assumed.
--
-- Existing policy inventory (6): SELECT `workspace_active` (id = the workspace
-- GUC), `workspace_membership_visible` (membership), `workspace_visible_bootstrap`
-- (slug = `app.bootstrap_slug`); UPDATE `workspace_mutate_active`; DELETE
-- `workspace_delete_active`; INSERT `workspace_insert_bootstrap`. The three write
-- policies are untouched, so the arm cannot rename, delete or create a
-- workspace, and the bootstrap slug pair keeps working exactly as it did.
--
-- MEASURED (2 000 workspaces), reading the workspace's own row:
--
--   BOUND — 0.153 ms
--     Index Scan using workspace_pkey on workspace (actual rows=1 loops=1)
--       SubPlan 1
--         ->  Index Scan using "project_workspaceId_identifier_key" on project p
--               (never executed)
--
--   UNBOUND — 0.192 ms
--     …same index path…
--       SubPlan 1
--         ->  Index Scan using "project_workspaceId_identifier_key" on project p
--               (actual rows=1 loops=1)
--
-- The semi-join is served by the existing `("workspaceId", "identifier")` unique
-- index, so it is an index scan and not the sequential scan the "it's a
-- semi-join, not a lookup" reading would predict. (`hashed SubPlan 3` also
-- appears in this plan — that is the PRE-EXISTING `workspace_membership_visible`
-- policy, not this arm. Do not read it as evidence about this one.)
-- ===========================================================================

CREATE POLICY "workspace_public_project_read" ON "workspace"
  FOR SELECT
  USING (
    coalesce(current_setting('app.workspace_id', true), '') = ''
    AND EXISTS (
      SELECT 1
      FROM "project" p
      WHERE p."workspaceId" = "workspace"."id"
        AND p."accessLevel" = 'public'
    )
  );

-- ===========================================================================
-- organization — the square's second hop, and the only one whose columns the
-- reader actually SEES (`o."name"`, `o."slug"` on every directory card).
--
-- Publicness is inherited twice, so the EXISTS walks the chain the read walks:
-- organization → workspace → project. That inner `workspace` read is itself
-- subject to `workspace`'s policies, INCLUDING the arm added directly above —
-- correct and deliberate: an org is visible unbound exactly when one of its
-- workspaces is, which is exactly when that workspace holds a public project.
-- The three arms decide one thing, once, and cannot disagree. (`project_public_read`
-- bottoms the chain out with a bare column test, so there is no recursion for
-- Postgres to refuse.)
--
-- ⚠️ GATED ON `app.workspace_id`, NOT ON `app.organization_id`, even though this
-- table's own policies key on the latter. The gate is not asking "is an org
-- bound?" — it is asking "is this the context-less public connection?", and the
-- workspace GUC is the one every bound path in the codebase sets
-- (`withWorkspaceContext`, `withWorkspaceServiceContext`, `tenantRead`). Keying
-- the gate on `app.organization_id` would open the arm inside ordinary
-- workspace-bound requests, which bind no org id — a strictly WIDER policy that
-- reads as tighter. Keeping all three arms on the same GUC also means "unbound"
-- means one thing across the whole public path.
--
-- Existing policy inventory (6), mirroring workspace: SELECT `organization_active`
-- (id = the org GUC), `organization_membership_visible`,
-- `organization_visible_bootstrap`; UPDATE `organization_mutate_active`; DELETE
-- `organization_delete_active`; INSERT `organization_insert_bootstrap`. FOR
-- SELECT matters most of the three here: the org row carries billing state
-- (`scaledTrackerSubscription`, `aiIncludedSeat`, `isMeta`), so a widened write
-- verb on this table would be a billing-TAMPERING surface, not merely a leak.
--
-- MEASURED (2 000 orgs), reading the org's own row:
--
--   BOUND (app.workspace_id + app.organization_id set) — 0.244 ms
--     Index Scan using organization_pkey on organization (actual rows=1 loops=1)
--       SubPlan 4
--         ->  Nested Loop (never executed)
--               ->  Index Scan using "workspace_organizationId_idx" (never executed)
--               ->  Index Scan using "project_workspaceId_identifier_key" (never executed)
--
--   UNBOUND — 0.164 ms
--     …same index path…
--       SubPlan 4
--         ->  Nested Loop (actual rows=1 loops=1)
--               ->  Index Scan using "workspace_organizationId_idx" (rows=1 loops=1)
--               ->  Index Scan using "project_workspaceId_identifier_key" (rows=1 loops=1)
--
-- Never executed on the bound path, so no tenant read pays for this. It is the
-- most expensive of the three when it DOES run — two index hops rather than one
-- — which is why it was measured rather than inferred from `work_item`'s result,
-- and why the "make it hash" rewrite was tried and rejected on numbers (see the
-- A/B at the top of this file). On the square's real query it runs `loops=25`:
-- once per card on the page, bounded by the page, not by the table.
-- ===========================================================================

CREATE POLICY "organization_public_project_read" ON "organization"
  FOR SELECT
  USING (
    coalesce(current_setting('app.workspace_id', true), '') = ''
    AND EXISTS (
      SELECT 1
      FROM "project" p
      JOIN "workspace" w ON w."id" = p."workspaceId"
      WHERE w."organizationId" = "organization"."id"
        AND p."accessLevel" = 'public'
    )
  );
