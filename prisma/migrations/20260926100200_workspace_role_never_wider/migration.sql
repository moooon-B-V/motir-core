-- The migration's NEVER-WIDER check (Story MOTIR-6168 · Subtask MOTIR-6461).
--
-- Runs straight after the mapping (`20260926100100_workspace_role_mapping`), in
-- the same `prisma migrate deploy`, because this is the only moment the OLD data
-- (workspace `role`, project roles, project custom roles) and the NEW data
-- (`workspace_role`, workspace custom roles) exist side by side. For EVERY
-- (person, project) pair — every workspace membership × every project of that
-- workspace — it computes:
--
--   * OLD: the key set the resolver granted before MOTIR-6459 — the legacy
--     workspace role's rail, else the project custom role / project role / the
--     implicit workspace-member set, filtered by the OLD per-level table;
--   * NEW: the key set the resolver grants now — the workspace role (or workspace
--     custom role), filtered by the NEW table, which reads only "was added".
--
-- and compares them:
--
--   * A WIDENING FAILS THE MIGRATION — `RAISE EXCEPTION` naming up to 50
--     (user, project, keys) — which fails `migrate deploy` and so the deploy,
--     before any new code reads the new columns. EXCEPT the one class the
--     approved model decides (`role-model.md` §3, "a person has the same role in
--     every project they can enter"): the person was never ADDED to that project,
--     and every key they gain there is inside the set their PLAIN-mapped role
--     holds (Manager / Member / Viewer from their legacy workspace role).
--     (The card named the class "a BUILT-IN new role"; a narrower custom role
--     chosen by the mapping gains keys in a project the person was never added to
--     by exactly the same rule, and every such key is inside the plain-mapped
--     set — so the class is stated over the plain-mapped SET, which admits that
--     case and still refuses a Viewer written as a Member, whose gained keys are
--     not in the Viewer set. Recorded on MOTIR-6461.)
--   * A NARROWING IS RECORDED, NEVER REFUSED: a person narrowed in any project
--     who has no report row yet gets one `mapped_narrower` row naming the
--     projects and the keys lost.
--
-- ⚠️ BOTH RULES ARE RE-STATED HERE AS LITERALS — a migration is a point in time
-- and must not import the application. `tests/migrations/workspaceRoleNeverWider.test.ts`
-- pins them: the built-in literals equal `BUILTIN_ROLE_PERMISSIONS`, the implicit
-- literal equals the committed snapshot of `IMPLICIT_WORKSPACE_MEMBER_PERMISSIONS`
-- taken at this PR's base (the constant itself is deleted by MOTIR-6459), and the
-- NEW function equals the TypeScript `resolvePermissions` pair by pair.

-- A named literal set.
CREATE FUNCTION pg_temp.nw_set(name text) RETURNS text[]
  LANGUAGE sql IMMUTABLE AS $f$
    SELECT CASE name
      -- @set gated (= the admin / Manager set)
      WHEN 'gated' THEN ARRAY[
        'ai:configure',
        'ai:decide_plan',
        'ai:plan',
        'ai:view_plan',
        'approval:decide_any',
        'approval:view_any',
        'attachment:create',
        'attachment:delete_any',
        'automation:manage',
        'board:configure',
        'comment:add',
        'comment:moderate',
        'component:manage',
        'estimation:manage',
        'field:manage',
        'import:run',
        'integration:manage',
        'label:manage',
        'lesson:manage',
        'lesson:reinforce',
        'lesson:view',
        'member:manage',
        'plan:view_any',
        'project:administer',
        'project:browse',
        'project:manage_access',
        'report:view',
        'repository:manage',
        'repository:manage_access',
        'run:view_any',
        'saved_filter:manage',
        'saved_filter:manage_any',
        'sprint:manage',
        'watcher:manage',
        'work_item:archive',
        'work_item:delete',
        'work_item:edit',
        'work_item:triage',
        'workflow:manage'
      ]::text[]
      -- @set member
      WHEN 'member' THEN ARRAY[
        'ai:decide_plan',
        'ai:plan',
        'ai:view_plan',
        'approval:view_any',
        'attachment:create',
        'comment:add',
        'plan:view_any',
        'project:browse',
        'report:view',
        'run:view_any',
        'saved_filter:manage',
        'sprint:manage',
        'work_item:archive',
        'work_item:edit',
        'work_item:triage'
      ]::text[]
      -- @set viewer
      WHEN 'viewer' THEN ARRAY[
        'approval:view_any',
        'plan:view_any',
        'project:browse',
        'report:view',
        'run:view_any'
      ]::text[]
      -- @set implicit (IMPLICIT_WORKSPACE_MEMBER_PERMISSIONS at the PR base)
      WHEN 'implicit' THEN ARRAY[
        'attachment:create',
        'comment:add',
        'plan:view_any',
        'project:browse',
        'report:view',
        'run:view_any',
        'work_item:edit'
      ]::text[]
      -- @set public (PUBLIC_PROJECT_PERMISSIONS)
      WHEN 'public' THEN ARRAY[
        'plan:view_any',
        'project:browse',
        'public_request:comment',
        'public_request:submit',
        'public_request:upvote',
        'run:view_any'
      ]::text[]
    END
  $f$;

-- Sorted, distinct, and with the one IMPLICATION both resolvers apply last
-- (`withImpliedPermissions`: `work_item:delete` confers `work_item:archive`).
CREATE FUNCTION pg_temp.nw_close(keys text[]) RETURNS text[]
  LANGUAGE sql IMMUTABLE AS $f$
    SELECT COALESCE(array_agg(DISTINCT k ORDER BY k), ARRAY[]::text[])
    FROM unnest(
      keys || CASE WHEN 'work_item:delete' = ANY(keys) THEN ARRAY['work_item:archive'] ELSE ARRAY[]::text[] END
    ) AS k
  $f$;

-- Whether `uid` is the Owner of the organization `ws` belongs to — the reach the
-- old and new gates both compose in (MOTIR-6308).
CREATE FUNCTION pg_temp.nw_is_org_owner(uid text, ws text) RETURNS boolean
  LANGUAGE sql STABLE AS $f$
    SELECT EXISTS (
      SELECT 1 FROM "organization_membership" om
      JOIN "workspace" w ON w."organizationId" = om."organizationId"
      WHERE w."id" = ws AND om."userId" = uid AND om."role" = 'owner'
    )
  $f$;

-- THE OLD RULE — `lib/permissions/resolve.ts` before MOTIR-6459.
CREATE FUNCTION pg_temp.nw_old_keys(uid text, pid text) RETURNS text[]
  LANGUAGE plpgsql STABLE AS $f$
  DECLARE
    lvl text;
    ws text;
    legacy text;
    pm_role text;
    pm_def text;
    has_pm boolean;
    is_pm_member boolean;
    base text[];
    held text[] := ARRAY[]::text[];
    k text;
  BEGIN
    SELECT p."accessLevel"::text, p."workspaceId" INTO lvl, ws FROM "project" p WHERE p."id" = pid;
    IF lvl = 'public' THEN held := pg_temp.nw_set('public'); END IF;
    SELECT wm."role"::text INTO legacy FROM "workspace_membership" wm
      WHERE wm."userId" = uid AND wm."workspaceId" = ws;
    -- The rail: a workspace owner / admin, or the org Owner.
    IF legacy IN ('owner', 'admin') OR pg_temp.nw_is_org_owner(uid, ws) THEN
      RETURN pg_temp.nw_close(held || pg_temp.nw_set('gated'));
    END IF;
    IF legacy IS NULL THEN RETURN pg_temp.nw_close(held); END IF;
    SELECT pm."role"::text, pm."role_definition_id" INTO pm_role, pm_def
      FROM "project_membership" pm WHERE pm."user_id" = uid AND pm."project_id" = pid;
    has_pm := FOUND;
    is_pm_member := pm_role IN ('admin', 'member');
    IF pm_def IS NOT NULL THEN
      SELECT ARRAY(SELECT x FROM unnest(prd."permissions") x WHERE x = ANY(pg_temp.nw_set('gated')))
        INTO base FROM "project_role_definition" prd WHERE prd."id" = pm_def;
    ELSIF has_pm THEN
      base := CASE pm_role WHEN 'admin' THEN pg_temp.nw_set('gated')
                           WHEN 'member' THEN pg_temp.nw_set('member')
                           ELSE pg_temp.nw_set('viewer') END;
    ELSE
      base := pg_temp.nw_set('implicit');
    END IF;
    FOREACH k IN ARRAY COALESCE(base, ARRAY[]::text[]) LOOP
      IF lvl IN ('open', 'public') THEN
        held := held || k;
      ELSIF lvl = 'limited' THEN
        IF k <> 'work_item:edit' OR is_pm_member THEN held := held || k; END IF;
      ELSIF lvl = 'private' THEN
        IF has_pm AND (k NOT IN ('work_item:edit', 'comment:add', 'attachment:create') OR is_pm_member) THEN
          held := held || k;
        END IF;
      END IF;
    END LOOP;
    RETURN pg_temp.nw_close(held);
  END
  $f$;

-- THE NEW RULE — `lib/permissions/resolve.ts` after MOTIR-6459.
CREATE FUNCTION pg_temp.nw_new_keys(uid text, pid text) RETURNS text[]
  LANGUAGE plpgsql STABLE AS $f$
  DECLARE
    lvl text;
    ws text;
    wrole text;
    wdef text;
    is_member boolean;
    added boolean;
    base text[];
    held text[] := ARRAY[]::text[];
    k text;
  BEGIN
    SELECT p."accessLevel"::text, p."workspaceId" INTO lvl, ws FROM "project" p WHERE p."id" = pid;
    IF lvl = 'public' THEN held := pg_temp.nw_set('public'); END IF;
    SELECT
      COALESCE(wm."workspace_role"::text,
        CASE wm."role" WHEN 'owner' THEN 'manager' WHEN 'admin' THEN 'manager'
                       WHEN 'member' THEN 'member' ELSE 'viewer' END),
      wm."role_definition_id"
      INTO wrole, wdef
      FROM "workspace_membership" wm WHERE wm."userId" = uid AND wm."workspaceId" = ws;
    is_member := FOUND;
    -- The Manager rail: a Manager, or the org Owner composed in as one.
    IF wrole = 'manager' OR pg_temp.nw_is_org_owner(uid, ws) THEN
      RETURN pg_temp.nw_close(held || pg_temp.nw_set('gated'));
    END IF;
    IF NOT is_member THEN RETURN pg_temp.nw_close(held); END IF;
    added := EXISTS (SELECT 1 FROM "project_membership" pm WHERE pm."user_id" = uid AND pm."project_id" = pid);
    IF wdef IS NOT NULL THEN
      SELECT ARRAY(SELECT x FROM unnest(wrd."permissions") x WHERE x = ANY(pg_temp.nw_set('gated')))
        INTO base FROM "workspace_role_definition" wrd WHERE wrd."id" = wdef;
    ELSE
      base := pg_temp.nw_set(wrole);
    END IF;
    FOREACH k IN ARRAY COALESCE(base, ARRAY[]::text[]) LOOP
      IF lvl IN ('open', 'public') THEN
        held := held || k;
      ELSIF lvl = 'limited' THEN
        IF k <> 'work_item:edit' OR added THEN held := held || k; END IF;
      ELSIF lvl = 'private' THEN
        IF added THEN held := held || k; END IF;
      END IF;
    END LOOP;
    RETURN pg_temp.nw_close(held);
  END
  $f$;

DO $$
DECLARE
  pair RECORD;
  old_k text[];
  new_k text[];
  gained text[];
  lost text[];
  plain text[];
  violations text[] := ARRAY[]::text[];
  violation_count integer := 0;
  n_pairs integer := 0;
  n_narrower integer := 0;
BEGIN
  CREATE TEMP TABLE _nw_lost (
    workspace_id text NOT NULL,
    user_id text NOT NULL,
    project_key text NOT NULL,
    lost text[] NOT NULL
  ) ON COMMIT DROP;

  FOR pair IN
    SELECT wm."userId" AS user_id, wm."workspaceId" AS workspace_id, wm."role"::text AS legacy,
           p."id" AS project_id, p."identifier" AS project_key,
           EXISTS (SELECT 1 FROM "project_membership" pm
                   WHERE pm."user_id" = wm."userId" AND pm."project_id" = p."id") AS added
    FROM "workspace_membership" wm
    JOIN "project" p ON p."workspaceId" = wm."workspaceId"
    ORDER BY wm."workspaceId", wm."userId", p."identifier"
  LOOP
    n_pairs := n_pairs + 1;
    old_k := pg_temp.nw_old_keys(pair.user_id, pair.project_id);
    new_k := pg_temp.nw_new_keys(pair.user_id, pair.project_id);
    gained := ARRAY(SELECT k FROM unnest(new_k) k WHERE NOT (k = ANY(old_k)) ORDER BY k);
    lost := ARRAY(SELECT k FROM unnest(old_k) k WHERE NOT (k = ANY(new_k)) ORDER BY k);

    IF cardinality(gained) > 0 THEN
      plain := pg_temp.nw_set(CASE pair.legacy WHEN 'owner' THEN 'gated' WHEN 'admin' THEN 'gated'
                                               WHEN 'member' THEN 'member' ELSE 'viewer' END);
      -- The ONE widening the model decides: never added here, and every gained
      -- key inside the plain-mapped role's set.
      IF pair.added OR NOT (gained <@ plain) THEN
        violation_count := violation_count + 1;
        IF violation_count <= 50 THEN
          violations := violations || format('user %s, project %s: +%s', pair.user_id, pair.project_key, array_to_string(gained, ','));
        END IF;
      END IF;
    END IF;

    IF cardinality(lost) > 0 THEN
      INSERT INTO _nw_lost VALUES (pair.workspace_id, pair.user_id, pair.project_key, lost);
    END IF;
  END LOOP;

  IF violation_count > 0 THEN
    RAISE EXCEPTION 'MOTIR-6461: the workspace-role migration WIDENS % (person, project) pair(s) beyond the one widening the model decides — refusing the deploy. First %: %',
      violation_count, LEAST(violation_count, 50), array_to_string(violations, '; ');
  END IF;

  -- A narrowing is recorded, never refused: one row per narrowed person who has
  -- no report row yet in that workspace.
  INSERT INTO "role_migration_report" ("id", "workspace_id", "user_id", "before_json", "after_role", "after_role_definition_id", "reason")
  SELECT gen_random_uuid()::text, l.workspace_id, l.user_id,
         jsonb_build_object('narrowedIn', jsonb_agg(jsonb_build_object('projectKey', l.project_key, 'lost', to_jsonb(l.lost)) ORDER BY l.project_key)),
         COALESCE(wm."workspace_role",
           CASE wm."role" WHEN 'owner' THEN 'manager'::"workspace_role" WHEN 'admin' THEN 'manager'::"workspace_role"
                          WHEN 'member' THEN 'member'::"workspace_role" ELSE 'viewer'::"workspace_role" END),
         wm."role_definition_id",
         'mapped_narrower'
  FROM _nw_lost l
  JOIN "workspace_membership" wm ON wm."userId" = l.user_id AND wm."workspaceId" = l.workspace_id
  WHERE NOT EXISTS (
    SELECT 1 FROM "role_migration_report" r
    WHERE r."workspace_id" = l.workspace_id AND r."user_id" = l.user_id
  )
  GROUP BY l.workspace_id, l.user_id, wm."workspace_role", wm."role", wm."role_definition_id";
  GET DIAGNOSTICS n_narrower = ROW_COUNT;

  RAISE NOTICE 'MOTIR-6461: % (person, project) pair(s) compared, none wider than decided; % mapped_narrower report row(s) written',
    n_pairs, n_narrower;
END $$;

DROP FUNCTION pg_temp.nw_new_keys(text, text);
DROP FUNCTION pg_temp.nw_old_keys(text, text);
DROP FUNCTION pg_temp.nw_is_org_owner(text, text);
DROP FUNCTION pg_temp.nw_close(text[]);
DROP FUNCTION pg_temp.nw_set(text);
