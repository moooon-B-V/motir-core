-- Row-level security for the workspace tables. The application sets two
-- per-transaction GUCs before issuing tenant-scoped queries:
--   app.user_id      — the authenticated user's id
--   app.workspace_id — the active workspace id resolved by the workspace-
--                      context middleware (lib/workspaces/middleware.ts)
-- See lib/workspaces/context.ts for the runtime side. RLS is the DB-layer
-- half of the defense-in-depth pair; even if an application code path
-- forgets a `where: { workspaceId }` filter, these policies still block
-- cross-tenant reads/writes.
--
-- `current_setting('<key>', true)` — the `true` is missing_ok: when the
-- GUC is unset the call returns NULL and the policy predicate evaluates
-- to NULL → row hidden. That's the safe failure mode (no context →
-- nothing visible) rather than the unsafe one (no context → everything
-- visible).
--
-- Why SELECT/UPDATE/DELETE policies (not FOR ALL): the workspace tables
-- are "tenant root" tables — INSERT establishes a tenant rather than
-- acting within one, so we can't sensibly gate INSERT on the workspace
-- GUC (the row being inserted IS the workspace; the GUC is set later
-- when somebody activates that workspace). createWorkspace runs in one
-- transaction that inserts both the workspace and the founding membership
-- before any context exists. Authorization for who can INSERT lives at
-- the application layer (signup hook in 1.2.4, invite acceptance in
-- 1.2.5). The policies below cover the SELECT/UPDATE/DELETE surface
-- where tenant isolation matters.
--
-- App role: prodect_app is created here (NOSUPERUSER NOBYPASSRLS) as the
-- runtime role production deploys should connect as. The default dev/
-- superuser role (`prodect`, created by the docker postgres image) has
-- BYPASSRLS implicitly and would render these policies inert. See the
-- planner-side PRODECT_FINDINGS.md for the deploy-time note.
--
-- ALTER ... FORCE ROW LEVEL SECURITY is set so that even the table-owner
-- role (which would otherwise bypass RLS on its own tables) is subject
-- to the policies. FORCE does not defeat the BYPASSRLS attribute on a
-- superuser — that's why the prodect_app role exists.

-- Application role. IF NOT EXISTS is wrapped in a DO block because
-- CREATE ROLE doesn't support IF NOT EXISTS directly.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'prodect_app') THEN
    CREATE ROLE prodect_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO prodect_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO prodect_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO prodect_app;
-- Future tables/sequences created by later migrations should also be grantable
-- without re-running this; ALTER DEFAULT PRIVILEGES handles that. Scoped to
-- the role running this migration so only its future objects are covered.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO prodect_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO prodect_app;

ALTER TABLE "workspace" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace" FORCE ROW LEVEL SECURITY;

ALTER TABLE "workspace_membership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_membership" FORCE ROW LEVEL SECURITY;

-- workspace: the row whose id matches the active-workspace GUC is visible.
CREATE POLICY "workspace_active" ON "workspace"
  FOR SELECT
  USING (id = current_setting('app.workspace_id', true));

-- workspace: any workspace the user is a member of is visible (so the
-- switcher can list them all and the bootstrap path can resolve the
-- active workspace from membership). With multiple permissive policies
-- Postgres OR-combines them, so a row passes if EITHER's USING returns
-- true.
CREATE POLICY "workspace_membership_visible" ON "workspace"
  FOR SELECT
  USING (
    id IN (
      SELECT "workspaceId"
      FROM "workspace_membership"
      WHERE "userId" = current_setting('app.user_id', true)
    )
  );

-- workspace: UPDATE/DELETE on a workspace require the active GUC to match
-- the row. Tighter than visibility (membership alone doesn't authorize
-- mutation — only operating in the workspace context does). Application-
-- layer role checks (admin vs member) layer on top in later Stories.
CREATE POLICY "workspace_mutate_active" ON "workspace"
  FOR UPDATE
  USING (id = current_setting('app.workspace_id', true));

CREATE POLICY "workspace_delete_active" ON "workspace"
  FOR DELETE
  USING (id = current_setting('app.workspace_id', true));

-- workspace_membership: rows for the active workspace are visible, AND
-- the user's own membership rows are always visible (so the switcher /
-- bootstrap path can read memberships before any workspace_id is set).
CREATE POLICY "membership_visible_active_or_own" ON "workspace_membership"
  FOR SELECT
  USING (
    "workspaceId" = current_setting('app.workspace_id', true)
    OR "userId" = current_setting('app.user_id', true)
  );

-- workspace_membership: UPDATE/DELETE require the row to belong to the
-- active workspace. (A user removing themselves from a workspace they're
-- not currently in is a 1.2.6 settings-UI concern — that path will switch
-- context first, then mutate.)
CREATE POLICY "membership_mutate_active" ON "workspace_membership"
  FOR UPDATE
  USING ("workspaceId" = current_setting('app.workspace_id', true));

CREATE POLICY "membership_delete_active_or_self" ON "workspace_membership"
  FOR DELETE
  USING (
    "workspaceId" = current_setting('app.workspace_id', true)
    OR "userId" = current_setting('app.user_id', true)
  );
