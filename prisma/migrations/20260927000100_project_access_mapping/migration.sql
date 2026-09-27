-- The access migration (Story MOTIR-6169 · Subtask MOTIR-6542).
--
-- Gives every project its ACCESS MODE by the mapping the DECISION confirmed
-- (`docs/decisions/role-model.md` Q1): `open` → `workspace`, `limited` →
-- `members`, `private` → `members`, `public` → `public`. Runs after the storage
-- (`20260927000000_project_access_storage`), which added `project.access_mode`
-- (NULL everywhere), `workspace_membership.access_scope` ('full' everywhere) and
-- the `project_access_lost` report reason in its own, already-committed file — an
-- added enum value cannot be USED in the transaction that adds it.
--
-- One PL/pgSQL block, in this order:
--
--   1. REPORT BEFORE MAPPING. `limited` meant "every workspace member views";
--      Members only admits only the people added. So for every `limited` project
--      and every member of its workspace who is not a Manager, not the org Owner
--      or an org Admin (who enter everything, `role-model.md` AMENDMENT 1) and was
--      not added, write ONE `project_access_lost` row. It must run before step 2,
--      which makes `limited` indistinguishable from `private` in `access_mode`.
--   2. MAP — `access_mode` from `accessLevel`, only `WHERE access_mode IS NULL`.
--      `accessLevel` is NOT written.
--   3. NEVER-WIDER. For every (workspace member, project) pair, OLD entry (the
--      level) against NEW entry (the mode, the scope, "was added"). Any pair the
--      new modes admit and the old levels did not RAISES, naming the first ten
--      pairs, which fails `migrate deploy` and so the deploy. The org Owner /
--      Admin rail enters on both sides and is left out of the comparison.
--   4. One NOTICE line per workspace: projects per mode, report rows written.
--
-- IDEMPOTENT: steps 1 and 2 touch only projects whose `access_mode` IS NULL, and
-- step 1 also skips a (person, project) that already carries a row, so a re-run
-- writes nothing and changes nothing; step 3 re-proves the invariant.
--
-- ⚠️ WHAT IT DOES NOT DO, AND WHY (a finding against the story body). The story
-- says "a narrowing project role becomes Limited scope plus the projects it
-- applied to". That clause has nothing left to act on: the role migration
-- (MOTIR-6458) already resolved every narrowing project role into the person's
-- WORKSPACE role (`narrowest_kept`, and `mapped_narrower` from MOTIR-6461), and
-- before this story nobody was barred from an `open` project. A Limited scope
-- here would take whole projects away from people whose role was already
-- narrowed. So every membership stays `full`: there is no UPDATE on
-- `workspace_membership` below.
--
-- ⚠️ BOTH ENTRY RULES ARE RE-STATED HERE AS LITERALS — a migration is a point in
-- time and must not import the application. OLD is `lib/permissions/resolve.ts`
-- `levelGrants` as it stood at this PR's base: `private` → added or Manager;
-- `open` / `limited` / `public` → any workspace member. NEW is the entry rule
-- the next card (MOTIR-6543) implements as `canEnter`: `members` → added or
-- Manager; `workspace` / `public` → Full scope, added, or Manager.

-- A person's workspace role: the migrated column, else the legacy mapping.
CREATE FUNCTION pg_temp.pa_role(wm_role text, wm_legacy text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $f$
    SELECT COALESCE(wm_role,
      CASE wm_legacy WHEN 'owner' THEN 'manager' WHEN 'admin' THEN 'manager'
                     WHEN 'member' THEN 'member' ELSE 'viewer' END)
  $f$;

-- Whether `uid` is the org Owner or an org Admin of the org `ws` belongs to.
CREATE FUNCTION pg_temp.pa_org_rail(uid text, ws text) RETURNS boolean
  LANGUAGE sql STABLE AS $f$
    SELECT EXISTS (
      SELECT 1 FROM "organization_membership" om
      JOIN "workspace" w ON w."organizationId" = om."organizationId"
      WHERE w."id" = ws AND om."userId" = uid AND om."role"::text IN ('owner', 'admin')
    )
  $f$;

DO $$
DECLARE
  pair RECORD;
  ws RECORD;
  old_enters boolean;
  new_enters boolean;
  violations text[] := ARRAY[]::text[];
  violation_count integer := 0;
  n_lost integer := 0;
BEGIN
  -- 1. REPORT BEFORE MAPPING.
  CREATE TEMP TABLE _pa_lost ON COMMIT DROP AS
  SELECT wm."workspaceId" AS workspace_id, wm."userId" AS user_id, p."identifier" AS project_key,
         pg_temp.pa_role(wm."workspace_role"::text, wm."role"::text) AS after_role,
         wm."role_definition_id" AS after_role_definition_id
  FROM "project" p
  JOIN "workspace_membership" wm ON wm."workspaceId" = p."workspaceId"
  WHERE p."access_mode" IS NULL
    AND p."accessLevel" = 'limited'
    AND pg_temp.pa_role(wm."workspace_role"::text, wm."role"::text) <> 'manager'
    AND NOT pg_temp.pa_org_rail(wm."userId", wm."workspaceId")
    AND NOT EXISTS (
      SELECT 1 FROM "project_membership" pm
      WHERE pm."user_id" = wm."userId" AND pm."project_id" = p."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "role_migration_report" r
      WHERE r."workspace_id" = wm."workspaceId" AND r."user_id" = wm."userId"
        AND r."reason" = 'project_access_lost'
        AND r."before_json"->>'projectKey' = p."identifier"
    );

  INSERT INTO "role_migration_report"
    ("id", "workspace_id", "user_id", "before_json", "after_role", "after_role_definition_id", "reason")
  SELECT gen_random_uuid()::text, l.workspace_id, l.user_id,
         jsonb_build_object('projectKey', l.project_key, 'accessLevel', 'limited'),
         l.after_role::"workspace_role", l.after_role_definition_id, 'project_access_lost'
  FROM _pa_lost l;
  GET DIAGNOSTICS n_lost = ROW_COUNT;

  -- 2. MAP.
  UPDATE "project" SET "access_mode" = CASE "accessLevel"
      WHEN 'open' THEN 'workspace'::"project_access_mode"
      WHEN 'limited' THEN 'members'::"project_access_mode"
      WHEN 'private' THEN 'members'::"project_access_mode"
      WHEN 'public' THEN 'public'::"project_access_mode"
    END
  WHERE "access_mode" IS NULL;

  -- 3. NEVER-WIDER.
  FOR pair IN
    SELECT wm."userId" AS user_id, wm."workspaceId" AS workspace_id,
           p."identifier" AS project_key, p."accessLevel"::text AS lvl, p."access_mode"::text AS mode,
           wm."access_scope"::text AS scope,
           pg_temp.pa_role(wm."workspace_role"::text, wm."role"::text) = 'manager' AS is_manager,
           EXISTS (SELECT 1 FROM "project_membership" pm
                   WHERE pm."user_id" = wm."userId" AND pm."project_id" = p."id") AS added
    FROM "workspace_membership" wm
    JOIN "project" p ON p."workspaceId" = wm."workspaceId"
    WHERE NOT pg_temp.pa_org_rail(wm."userId", wm."workspaceId")
    ORDER BY wm."workspaceId", p."identifier", wm."userId"
  LOOP
    old_enters := CASE WHEN pair.lvl = 'private' THEN pair.added OR pair.is_manager ELSE true END;
    new_enters := CASE WHEN pair.mode = 'members' THEN pair.added OR pair.is_manager
                       ELSE pair.scope = 'full' OR pair.added OR pair.is_manager END;
    IF new_enters AND NOT old_enters THEN
      violation_count := violation_count + 1;
      IF violation_count <= 10 THEN
        violations := violations || format('user %s, project %s (%s → %s)',
          pair.user_id, pair.project_key, pair.lvl, pair.mode);
      END IF;
    END IF;
  END LOOP;

  IF violation_count > 0 THEN
    RAISE EXCEPTION 'MOTIR-6542: the access modes ADMIT % (person, project) pair(s) the old access levels did not — refusing the deploy. First %: %',
      violation_count, LEAST(violation_count, 10), array_to_string(violations, '; ');
  END IF;

  -- 4. One line per workspace.
  FOR ws IN
    SELECT p."workspaceId" AS workspace_id,
           count(*) FILTER (WHERE p."access_mode" = 'workspace') AS n_workspace,
           count(*) FILTER (WHERE p."access_mode" = 'members') AS n_members,
           count(*) FILTER (WHERE p."access_mode" = 'public') AS n_public,
           (SELECT count(*) FROM _pa_lost l WHERE l.workspace_id = p."workspaceId") AS n_lost
    FROM "project" p
    GROUP BY p."workspaceId"
    ORDER BY p."workspaceId"
  LOOP
    RAISE NOTICE 'MOTIR-6542: workspace %: % workspace · % members · % public; % project_access_lost row(s)',
      ws.workspace_id, ws.n_workspace, ws.n_members, ws.n_public, ws.n_lost;
  END LOOP;
  RAISE NOTICE 'MOTIR-6542: % project_access_lost report row(s) written in total', n_lost;
END $$;

DROP FUNCTION pg_temp.pa_org_rail(text, text);
DROP FUNCTION pg_temp.pa_role(text, text);
