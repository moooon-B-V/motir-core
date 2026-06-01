-- Row-level security for the `work_item` and `work_item_link` tables. This is
-- the DB-layer half of the defense-in-depth pair for issue-data tenancy
-- (Story 1.4 · Subtask 1.4.5). The application-layer half is the
-- workspace-context middleware that opens a transaction via
-- withWorkspaceContext (lib/workspaces/context.ts) and binds the GUCs these
-- policies read BEFORE issuing any tenant-scoped query. Even if a future
-- application code path forgets a `where: { workspaceId }` filter, these
-- policies still block cross-tenant reads/writes.
--
-- SCOPE NOTE (PRODECT_FINDINGS #20): Story 1.4's third table,
-- `work_item_revision`, does NOT exist yet — its CREATE TABLE lands in
-- Subtask 1.4.6, and 1.4.6 ships the revision-table RLS policy in the SAME
-- migration as the table (so there is never a transient window where the
-- table exists unguarded). This migration therefore covers `work_item` and
-- `work_item_link` ONLY. Do not add a policy for a table that doesn't exist.
--
-- Policy shape mirrors the project migration (20260529202445_add_project_rls):
--   * ENABLE + FORCE so even the table-owner role is subject to the policy.
--     FORCE does NOT defeat the BYPASSRLS attribute on a superuser — that's
--     why the non-bypass `prodect_app` role exists (created by
--     20260527134009_add_workspace_rls); production deploys connect as it
--     (PRODECT_FINDINGS #5).
--   * `current_setting('app.workspace_id', true)` — the `true` is missing_ok,
--     so an unset GUC yields NULL → the predicate evaluates to NULL → row
--     hidden. That's the safe failure mode (no context → nothing visible)
--     rather than the unsafe one (no context → everything visible).
--   * FOR ALL on a single permissive policy per table: unlike the workspace
--     table (where INSERT ESTABLISHES tenancy and so the workspace_id GUC
--     isn't set yet at create-time), every work-item / link write happens
--     INSIDE an already-active workspace context. The workspace_id GUC is
--     always set, so the same predicate covers SELECT/INSERT/UPDATE/DELETE
--     via USING + WITH CHECK.
--   * WITH CHECK enforces the predicate on rows being INSERTed/UPDATEd, so a
--     compromised or buggy path can neither insert a work item / link into a
--     different workspace than the active one, nor reparent an existing row
--     across workspaces (flipping workspaceId to a foreign tenant).
--
-- Grants: the workspace RLS migration's `ALTER DEFAULT PRIVILEGES IN SCHEMA
-- public ... TO prodect_app` makes every NEW table created by the same role
-- (`prodect`) auto-inheritably grantable. `work_item` (20260530230912) and
-- `work_item_link` (20260531231110) were both created by that role, so
-- SELECT/INSERT/UPDATE/DELETE are already in place for prodect_app. No
-- explicit GRANT needed here.
--
-- ---------------------------------------------------------------------------
-- PERMISSIVE vs RESTRICTIVE — the two-policy layering on `work_item`
-- ---------------------------------------------------------------------------
-- `work_item` carries TWO policies, and the distinction between PERMISSIVE
-- and RESTRICTIVE is load-bearing. Read this before editing either.
--
-- Postgres combines multiple policies on the same command as:
--     (permissive_1 OR permissive_2 OR ...) AND (restrictive_1 AND ...)
-- i.e. permissive policies are OR'd together (any one passing grants access),
-- while restrictive policies are AND'd onto the result (every one must pass).
--
-- We want the project filter to NARROW reads (AND), never to WIDEN them (OR).
-- If the project filter were a second PERMISSIVE policy, a row would pass
-- SELECT when EITHER the workspace check OR the project check returned true —
-- so a row from a DIFFERENT workspace whose projectId happened to match the
-- (cross-tenant) project GUC could leak. That's widening, the opposite of
-- what we want. Making the project filter RESTRICTIVE fixes this: the
-- workspace permissive policy still gates membership (a row must belong to
-- the active workspace), and the restrictive project policy is AND'd on top
-- to further narrow reads to a single project when `app.project_id` is set.
--
--   work_item_active_workspace  (PERMISSIVE, FOR ALL)  — workspace gate; the
--       row must belong to the active workspace for ANY operation. This is
--       the policy that "bites" on writes (USING + WITH CHECK).
--   work_item_project_narrow    (RESTRICTIVE, FOR SELECT) — read-side only;
--       when `app.project_id` is set, AND-narrows visible rows to that one
--       project. When unset/empty, the coalesce(...) = '' branch is true so
--       it imposes no restriction (all workspace projects remain visible).
--
-- The project narrowing is FOR SELECT only by design: INSERT/UPDATE/DELETE
-- must still pass the workspace check (and only that), so a write is never
-- silently scoped out by a stale project GUC. A restrictive policy with no
-- USING clause for INSERT/UPDATE would otherwise have to be reasoned about
-- carefully; scoping it to SELECT keeps the write path governed purely by
-- the workspace policy's WITH CHECK.
--
-- This layering is the durable shape for Epic 6's RBAC: when "only project
-- members may see issues" arrives, it slots in as another RESTRICTIVE
-- policy that AND's onto the existing two — no rework of the workspace gate.
--
-- ---------------------------------------------------------------------------
-- TRIGGER FUNCTIONS UNDER FORCE RLS (PRODECT_FINDINGS #19)
-- ---------------------------------------------------------------------------
-- The structural-integrity triggers from 1.4.2 (kind/depth/cycle on
-- work_item) and 1.4.3 (cycle/self/workspace on work_item_link) each run
-- internal `SELECT ... FROM work_item` / `SELECT ... FROM work_item_link`
-- lookups. Under FORCE RLS those internal SELECTs are evaluated under the
-- invoking statement's policies — i.e. filtered by `app.workspace_id` (and,
-- for work_item, the restrictive project filter too). Subtask 1.4.5 verifies
-- in tests/work-item-rls.test.ts that the triggers still fire correctly under
-- the non-bypass prodect_app role: within a single workspace a row and its
-- ancestors / link endpoints share one workspaceId, so the active GUC matches
-- every row the triggers walk, and the integrity checks see the whole
-- subtree. If that verification had failed, the six trigger functions would
-- have been marked SECURITY DEFINER in a follow-up migration; see the test
-- file and the PR body for the verdict.

ALTER TABLE "work_item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "work_item" FORCE ROW LEVEL SECURITY;

ALTER TABLE "work_item_link" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "work_item_link" FORCE ROW LEVEL SECURITY;

-- work_item: PERMISSIVE workspace gate. A work item is visible/mutable only
-- when it belongs to the currently-active workspace. USING governs
-- SELECT/UPDATE/DELETE visibility; WITH CHECK governs the post-image of
-- INSERT/UPDATE so a write can't place (or move) a row into a foreign
-- workspace.
CREATE POLICY "work_item_active_workspace" ON "work_item"
  FOR ALL
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));

-- work_item: RESTRICTIVE project narrowing (read-side only). AND'd onto the
-- workspace policy above (see the PERMISSIVE vs RESTRICTIVE block). When
-- `app.project_id` is unset OR empty-string, the coalesce(...) = '' branch is
-- true and the policy imposes no restriction (all workspace projects
-- visible). When set, it narrows visible rows to that one project. Applies to
-- SELECT only — writes remain governed by the workspace policy alone.
CREATE POLICY "work_item_project_narrow" ON "work_item"
  AS RESTRICTIVE
  FOR SELECT
  USING (
    coalesce(current_setting('app.project_id', true), '') = ''
    OR "projectId" = current_setting('app.project_id', true)
  );

-- work_item_link: single PERMISSIVE workspace gate. The denormalized
-- `workspaceId` column (kept honest by the 1.4.3 workspace-consistency
-- trigger) makes this a direct comparison — no join. Deliberately NO project
-- narrowing: cross-project links inside one workspace are a v1 use case
-- (Story 1.4 § Dependencies — an epic's stories live in sibling projects),
-- so the link table is workspace-scoped only.
CREATE POLICY "work_item_link_active_workspace" ON "work_item_link"
  FOR ALL
  USING ("workspaceId" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true));
