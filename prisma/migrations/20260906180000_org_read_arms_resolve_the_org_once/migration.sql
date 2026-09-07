-- THE ORG READ ARMS, MADE CHEAP — Story MOTIR-4669 · MOTIR-4677 / MOTIR-4679.
--
-- ⚠️ THIS CHANGES NO ROW'S VISIBILITY. Every predicate below admits exactly the
-- set its predecessor admitted, under exactly the caller's own policies. What
-- changes is HOW OFTEN Postgres resolves the caller's organisation.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT WENT WRONG — AND WHERE IT SHOWED UP, WHICH IS THE POINT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The four arms shipped by `20260905214500_github_org_read_arms` and
-- `20260906000000_project_repository_org_read_arm` each resolved the caller's
-- organisation INSIDE a correlated `EXISTS` that also referenced the row being
-- filtered:
--
--   EXISTS (SELECT 1 FROM workspace w
--            WHERE w.id = current_setting('app.workspace_id', true)
--              AND w."organizationId" = github_repo.organization_id)
--
-- Because the body mentions the outer row, the planner cannot hoist it: the
-- lookup runs per candidate row. And it is not a cheap lookup — `workspace` is
-- itself RLS-enabled with FORCE, so each evaluation layers `workspace`'s own
-- policies (one of which tests `organization_membership`) inside the visibility
-- test of every row of four of the busiest tables in the schema.
-- `github_check_run`'s arm nested that two joins deep.
--
-- The cost landed nowhere near this story's surfaces. Measured on one machine,
-- one file, `tests/github/ciGreenPromotion.test.ts` — which touches no
-- repository surface at all:
--
--     no org arms .................. 8.3 s
--     the four arms as shipped .... 23.4 s
--     the four arms as below ....... 8.4 s
--
-- In CI, where twelve shards contend for one Postgres, that 3× fell over the
-- 15 s per-test timeout in EIGHT of them, in files with nothing to do with
-- repositories. A policy is not a feature of the surface that motivated it; it
-- is a tax on every read of the table, for ever.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE FIX: RESOLVE THE ORGANISATION ONCE PER QUERY, NOT ONCE PER ROW
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `app_caller_organization_id()` takes no argument and reads only the GUC, so
-- `(SELECT app_caller_organization_id())` is an UNCORRELATED subquery: Postgres
-- evaluates it as an InitPlan, once per query, and compares the cached value per
-- row. The function's own body is planned once and cached, instead of being
-- re-planned inline into every policy expression it appears in.
--
-- ⚠️ IT IS `SECURITY INVOKER` — the default, and deliberately so. It was measured
-- against a `SECURITY DEFINER` variant and there is nothing to buy: 8.4 s vs
-- 8.8 s, inside the noise. The whole gain is the InitPlan, not RLS bypass. So
-- the property the original migration documented is PRESERVED EXACTLY — the
-- lookup still runs under the caller's own policies on `workspace`, and resolves
-- because `workspace_active` admits `id = app.workspace_id`, the one row it
-- reads. A `SECURITY DEFINER` function here would have bought nothing and left a
-- privilege boundary for someone to get wrong later.
--
-- It is STABLE (it reads a GUC and a table; it is not IMMUTABLE) and pins
-- `search_path`, so nothing shadows `workspace` for it.
--
-- FAILS CLOSED, identically. With nothing bound, `current_setting(…, true)` is
-- NULL, the function finds no row and returns NULL, and every comparison against
-- it is NULL — the row is refused. A NULL `organization_id` is refused for the
-- same reason. Nothing is admitted that was not admitted before.
--
-- Three of the four arms also switch from a per-row `EXISTS` to SET MEMBERSHIP
-- (`x IN (…)`): an organisation has few workspaces and few repositories, the
-- subqueries are uncorrelated, and Postgres builds each set once and probes it.
-- `github_check_run` keeps a correlated `EXISTS` because it must key on its own
-- `pull_request_id` — but that is now one primary-key lookup and a probe.

-- ---------------------------------------------------------------------------
-- 0 · the caller's organisation, resolved once
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_caller_organization_id() RETURNS text
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT w."organizationId"
    FROM "workspace" w
   WHERE w."id" = current_setting('app.workspace_id', true)
$$;

COMMENT ON FUNCTION app_caller_organization_id() IS
  'The organisation owning the workspace bound to app.workspace_id, or NULL when '
  'no workspace is bound. SECURITY INVOKER: it reads `workspace` under the '
  'caller''s own policies, exactly as the inline subquery it replaces did. '
  'Wrap calls as (SELECT app_caller_organization_id()) so the planner evaluates '
  'it once per query rather than once per row — that is the whole reason it '
  'exists (Story MOTIR-4669).';

-- ---------------------------------------------------------------------------
-- 1 · github_repo — a column comparison against the cached value
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "github_repo_org_read" ON "github_repo";
CREATE POLICY "github_repo_org_read" ON "github_repo"
  FOR SELECT
  USING (
    "organization_id" = (SELECT app_caller_organization_id())
    OR "organization_id" = (SELECT current_setting('app.organization_id', true))
  );

-- ---------------------------------------------------------------------------
-- 2 · github_pull_request — set membership on the organisation's repositories
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "github_pull_request_org_read" ON "github_pull_request";
CREATE POLICY "github_pull_request_org_read" ON "github_pull_request"
  FOR SELECT
  USING (
    "repo_id" IN (
      SELECT r."id" FROM "github_repo" r
       WHERE r."organization_id" = (SELECT app_caller_organization_id())
          OR r."organization_id" = (SELECT current_setting('app.organization_id', true))
    )
  );

-- ---------------------------------------------------------------------------
-- 3 · github_check_run — one PK lookup, then a probe into that same set
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "github_check_run_org_read" ON "github_check_run";
CREATE POLICY "github_check_run_org_read" ON "github_check_run"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "github_pull_request" p
       WHERE p."id" = "github_check_run"."pull_request_id"
         AND p."repo_id" IN (
               SELECT r."id" FROM "github_repo" r
                WHERE r."organization_id" = (SELECT app_caller_organization_id())
                   OR r."organization_id" = (SELECT current_setting('app.organization_id', true))
             )
    )
  );

-- ---------------------------------------------------------------------------
-- 4 · project_repository — set membership on the organisation's workspaces
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "project_repository_org_read" ON "project_repository";
CREATE POLICY "project_repository_org_read" ON "project_repository"
  FOR SELECT
  USING (
    "workspace_id" IN (
      SELECT o."id" FROM "workspace" o
       WHERE o."organizationId" = (SELECT app_caller_organization_id())
          OR o."organizationId" = (SELECT current_setting('app.organization_id', true))
    )
  );
