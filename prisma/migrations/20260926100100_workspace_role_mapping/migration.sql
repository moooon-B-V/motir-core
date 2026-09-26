-- The role migration's MAPPING (Story MOTIR-6168 · Subtask MOTIR-6458).
--
-- Every workspace membership is given ONE workspace role, by the table the
-- DECISION approved on 2026-09-25 (`docs/decisions/role-model.md`, "Also
-- recorded: migrating today's roles", and Q2). Every person whose role was
-- chosen by anything other than the plain mapping gets a `role_migration_report`
-- row saying why. In order:
--
--   1. RE-CREATE CUSTOM ROLES AT THEIR WORKSPACE. Every `project_role_definition`
--      becomes a `workspace_role_definition` in the same workspace with the same
--      permissions. Two with the IDENTICAL key set in one workspace become ONE
--      row. Two with the same name and different sets keep the name for the first
--      and take "<name> (<PROJECT_KEY>)" for the others.
--   2. MAP THE WORKSPACE ROLE. owner / admin → manager; member → member;
--      viewer → viewer. A Manager's project roles are ignored: the Manager rail
--      already held every role-gated key in every project (`resolve.ts` layer 2).
--   3. KEEP THE NARROWEST, for everyone below Manager (Q2). The candidates are
--      the mapped built-in's set, each project membership's built-in set, and
--      each custom role the person holds.
--        * a project role WIDER than the mapped role (a strict superset) is not a
--          candidate: it is dropped and reported `project_role_dropped` — the
--          person loses those extra keys in that project, as the DECISION's
--          migration section decides;
--        * if one candidate is a subset of every other, it is the role —
--          `narrowest_kept` when it is a different built-in, `custom_role_recreated`
--          when it is a custom role;
--        * if none is (incomparable custom roles), ONE workspace custom role holding
--          the INTERSECTION is created (named by joining the sources with " ∩ ",
--          deduped per workspace by key set), assigned, and reported
--          `custom_role_merged`.
--   4. A WORKSPACE OWNER BECOMES AN ORG ADMIN, unless they are already the org's
--      Owner or an Admin — reported `org_admin_granted`.
--   5. REPORT: one row per person per reason; `before_json` carries the legacy
--      workspace role and every { projectKey, role, customRoleName } they held.
--   6. One RAISE NOTICE per workspace with its counts (the MOTIR-6308 pattern).
--
-- ⚠️ THE BUILT-IN KEY SETS BELOW ARE LITERALS — a snapshot of
-- `BUILTIN_ROLE_PERMISSIONS` (`lib/permissions/builtinRoles.ts`) at this PR's
-- base. A migration is a point in time and must not import the application;
-- `tests/migrations/workspaceRoleMapping.test.ts` parses these literals and fails
-- the moment they stop EQUALLING the constants, so a key added to a role before
-- this merges turns red instead of silently migrating a stale set. A stored custom
-- set is compared after intersecting it with the catalogue (the `admin` literal
-- IS `ROLE_GATED_PERMISSIONS`), exactly as the resolver ignores a retired key.
--
-- ⚠️ IDEMPOTENT, and it has to be: it touches only memberships
-- `WHERE workspace_role IS NULL`, and every role it creates is found again BY KEY
-- SET before a new one is inserted — so a re-run over a migrated database writes
-- no row at all. That the result is never WIDER than before is NOT asserted here:
-- it is the next migration's job (MOTIR-6461), which can fail the deploy even if
-- this one contains a bug. This migration's own guarantees are determinism and
-- idempotence. No legacy column is written.
--
-- One SQL migration, applied by `prisma migrate deploy` in the build, the route the
-- deploy already runs — no hand-run script, no manual step.

-- The comparison key of a permission set: its keys, deduplicated, sorted, and
-- intersected with the role-gated catalogue. Session-scoped (`pg_temp`) and
-- dropped at the end, so the migration leaves no function behind.
CREATE FUNCTION pg_temp.wr_norm(perms text[], catalogue text[]) RETURNS text[]
  LANGUAGE sql IMMUTABLE AS $f$
    SELECT COALESCE(array_agg(DISTINCT k ORDER BY k), ARRAY[]::text[])
    FROM unnest(perms) AS k
    WHERE k = ANY(catalogue)
  $f$;

-- A name for a new workspace role in `ws`: `base` when free, else `fallback`,
-- else `fallback` with a counter — so two differing roles never merge on a name
-- and the (workspace_id, name) unique index can never fail this migration.
CREATE FUNCTION pg_temp.wr_free_name(ws text, base text, fallback text) RETURNS text
  LANGUAGE plpgsql AS $f$
  DECLARE
    candidate text := base;
    n integer := 2;
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM "workspace_role_definition" WHERE "workspace_id" = ws AND "name" = candidate) THEN
      RETURN candidate;
    END IF;
    candidate := fallback;
    WHILE EXISTS (SELECT 1 FROM "workspace_role_definition" WHERE "workspace_id" = ws AND "name" = candidate) LOOP
      candidate := fallback || ' ' || n;
      n := n + 1;
    END LOOP;
    RETURN candidate;
  END
  $f$;

DO $$
DECLARE
  -- ── The built-in key sets, a snapshot of BUILTIN_ROLE_PERMISSIONS ──────────
  -- @builtin admin
  admin_set text[] := ARRAY[
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
  ]::text[];
  -- @builtin member
  member_set text[] := ARRAY[
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
  ]::text[];
  -- @builtin viewer
  viewer_set text[] := ARRAY[
    'approval:view_any',
    'plan:view_any',
    'project:browse',
    'report:view',
    'run:view_any'
  ]::text[];

  pr RECORD;
  m RECORD;
  c RECORD;
  found_id text;
  norm text[];
  mapped_role "workspace_role";
  mapped_set text[];
  final_role "workspace_role";
  final_def text;
  inter text[];
  merged_name text;
  dropped boolean;
  mapped_norm text[];
  chosen_reason "role_migration_reason";
  before jsonb;
  org_role "organization_role";
  granted boolean;
BEGIN
  CREATE TEMP TABLE _wr_role_map (
    project_role_id text PRIMARY KEY,
    workspace_role_id text NOT NULL
  ) ON COMMIT DROP;
  CREATE TEMP TABLE _wr_cand (
    kind text NOT NULL,          -- 'mapped' | 'builtin' | 'custom'
    role "workspace_role",       -- the built-in, for 'mapped' / 'builtin'
    def_id text,                 -- the workspace role, for 'custom'
    name text NOT NULL,
    perms text[] NOT NULL
  ) ON COMMIT DROP;
  CREATE TEMP TABLE _wr_counts (
    workspace_id text PRIMARY KEY,
    managers integer NOT NULL DEFAULT 0,
    members integer NOT NULL DEFAULT 0,
    viewers integer NOT NULL DEFAULT 0,
    custom integer NOT NULL DEFAULT 0,
    reported integer NOT NULL DEFAULT 0
  ) ON COMMIT DROP;

  -- ── 1. Re-create every project custom role at its workspace ───────────────
  FOR pr IN
    SELECT prd."id", prd."workspace_id", prd."name", prd."permissions", p."identifier"
    FROM "project_role_definition" prd
    JOIN "project" p ON p."id" = prd."project_id"
    ORDER BY prd."workspace_id", prd."created_at", prd."id"
  LOOP
    norm := pg_temp.wr_norm(pr."permissions", admin_set);
    SELECT wrd."id" INTO found_id
    FROM "workspace_role_definition" wrd
    WHERE wrd."workspace_id" = pr."workspace_id"
      AND pg_temp.wr_norm(wrd."permissions", admin_set) = norm
    ORDER BY wrd."created_at", wrd."id"
    LIMIT 1;
    IF found_id IS NULL THEN
      INSERT INTO "workspace_role_definition" ("id", "workspace_id", "name", "permissions", "created_at", "updated_at")
      VALUES (
        gen_random_uuid()::text,
        pr."workspace_id",
        pg_temp.wr_free_name(pr."workspace_id", pr."name", pr."name" || ' (' || pr."identifier" || ')'),
        pr."permissions",
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
      RETURNING "id" INTO found_id;
    END IF;
    INSERT INTO _wr_role_map VALUES (pr."id", found_id);
  END LOOP;

  -- ── 2–5. One workspace role per membership ─────────────────────────────────
  FOR m IN
    SELECT wm."id", wm."userId", wm."workspaceId", wm."role", w."organizationId"
    FROM "workspace_membership" wm
    JOIN "workspace" w ON w."id" = wm."workspaceId"
    WHERE wm."workspace_role" IS NULL
    ORDER BY wm."workspaceId", wm."userId"
  LOOP
    INSERT INTO _wr_counts ("workspace_id") VALUES (m."workspaceId") ON CONFLICT DO NOTHING;

    -- 5 (before): the legacy workspace role and every project role held here.
    SELECT jsonb_build_object(
      'workspaceRole', m."role",
      'projects', COALESCE(jsonb_agg(
        jsonb_build_object('projectKey', p."identifier", 'role', pm."role", 'customRoleName', prd."name")
        ORDER BY p."identifier"
      ) FILTER (WHERE pm."id" IS NOT NULL), '[]'::jsonb)
    ) INTO before
    FROM (SELECT 1) AS one
    LEFT JOIN "project_membership" pm
      ON pm."user_id" = m."userId" AND pm."workspace_id" = m."workspaceId"
    LEFT JOIN "project" p ON p."id" = pm."project_id"
    LEFT JOIN "project_role_definition" prd ON prd."id" = pm."role_definition_id";

    -- 2 + 4: owner / admin → Manager; a workspace owner also becomes an org Admin.
    IF m."role" IN ('owner', 'admin') THEN
      UPDATE "workspace_membership" SET "workspace_role" = 'manager', "role_definition_id" = NULL
      WHERE "id" = m."id";
      UPDATE _wr_counts SET managers = managers + 1 WHERE workspace_id = m."workspaceId";
      IF m."role" = 'owner' THEN
        granted := false;
        SELECT om."role" INTO org_role FROM "organization_membership" om
        WHERE om."organizationId" = m."organizationId" AND om."userId" = m."userId";
        IF NOT FOUND THEN
          INSERT INTO "organization_membership" ("id", "organizationId", "userId", "role", "createdAt", "updatedAt")
          VALUES (gen_random_uuid()::text, m."organizationId", m."userId", 'admin', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
          granted := true;
        ELSIF org_role = 'member' THEN
          UPDATE "organization_membership" SET "role" = 'admin', "updatedAt" = CURRENT_TIMESTAMP
          WHERE "organizationId" = m."organizationId" AND "userId" = m."userId";
          granted := true;
        END IF;
        IF granted THEN
          INSERT INTO "role_migration_report" ("id", "workspace_id", "user_id", "before_json", "after_role", "reason")
          VALUES (gen_random_uuid()::text, m."workspaceId", m."userId", before, 'manager', 'org_admin_granted');
          UPDATE _wr_counts SET reported = reported + 1 WHERE workspace_id = m."workspaceId";
        END IF;
      END IF;
      CONTINUE;
    END IF;

    -- 2: the plain mapping.
    IF m."role" = 'member' THEN
      mapped_role := 'member';
      mapped_set := member_set;
    ELSE
      mapped_role := 'viewer';
      mapped_set := viewer_set;
    END IF;
    mapped_norm := pg_temp.wr_norm(mapped_set, admin_set);

    -- 3: the candidates.
    TRUNCATE _wr_cand;
    INSERT INTO _wr_cand VALUES ('mapped', mapped_role, NULL, initcap(mapped_role::text), mapped_norm);
    INSERT INTO _wr_cand
    SELECT DISTINCT
      'builtin',
      CASE pm."role" WHEN 'viewer' THEN 'viewer'::"workspace_role" ELSE 'member'::"workspace_role" END,
      NULL,
      initcap(pm."role"::text),
      pg_temp.wr_norm(
        CASE pm."role" WHEN 'admin' THEN admin_set WHEN 'member' THEN member_set ELSE viewer_set END,
        admin_set
      )
    FROM "project_membership" pm
    WHERE pm."user_id" = m."userId" AND pm."workspace_id" = m."workspaceId"
      AND pm."role_definition_id" IS NULL;
    INSERT INTO _wr_cand
    SELECT DISTINCT 'custom', NULL::"workspace_role", wrd."id", wrd."name", pg_temp.wr_norm(wrd."permissions", admin_set)
    FROM "project_membership" pm
    JOIN _wr_role_map rm ON rm.project_role_id = pm."role_definition_id"
    JOIN "workspace_role_definition" wrd ON wrd."id" = rm.workspace_role_id
    WHERE pm."user_id" = m."userId" AND pm."workspace_id" = m."workspaceId";

    -- A project role WIDER than the mapped role is dropped (a strict superset).
    DELETE FROM _wr_cand
    WHERE kind <> 'mapped' AND mapped_norm <@ perms AND NOT (perms <@ mapped_norm);
    dropped := FOUND;

    -- The narrowest: a candidate every other candidate contains. Prefer the
    -- mapped role, then a built-in, then a custom role by name — so equal sets
    -- resolve to the plainest answer.
    SELECT * INTO c FROM _wr_cand a
    WHERE NOT EXISTS (SELECT 1 FROM _wr_cand b WHERE NOT (a.perms <@ b.perms))
    ORDER BY CASE a.kind WHEN 'mapped' THEN 0 WHEN 'builtin' THEN 1 ELSE 2 END, a.name
    LIMIT 1;

    IF FOUND THEN
      IF c.kind = 'custom' THEN
        final_role := 'member';        -- CUSTOM_WORKSPACE_ROLE_TIER
        final_def := c.def_id;
        chosen_reason := 'custom_role_recreated';
      ELSE
        final_role := c.role;
        final_def := NULL;
        chosen_reason := CASE WHEN c.role <> mapped_role THEN 'narrowest_kept'::"role_migration_reason" END;
      END IF;
    ELSE
      chosen_reason := 'custom_role_merged';
      -- Incomparable: one workspace role holding the INTERSECTION of them all.
      SELECT array_agg(k ORDER BY k) INTO inter
      FROM (
        SELECT k FROM _wr_cand, unnest(perms) AS k GROUP BY k
        HAVING count(*) = (SELECT count(*) FROM _wr_cand)
      ) AS keys;
      inter := COALESCE(inter, ARRAY[]::text[]);
      -- Named by its SOURCES — the project roles that disagreed, not the mapped
      -- built-in that contains them all.
      SELECT string_agg(DISTINCT name, ' ∩ ' ORDER BY name) INTO merged_name
      FROM _wr_cand WHERE kind <> 'mapped';
      IF inter = pg_temp.wr_norm(viewer_set, admin_set) THEN
        final_role := 'viewer';
        final_def := NULL;
      ELSIF inter = pg_temp.wr_norm(member_set, admin_set) THEN
        final_role := 'member';
        final_def := NULL;
      ELSE
        SELECT wrd."id" INTO found_id FROM "workspace_role_definition" wrd
        WHERE wrd."workspace_id" = m."workspaceId"
          AND pg_temp.wr_norm(wrd."permissions", admin_set) = inter
        ORDER BY wrd."created_at", wrd."id"
        LIMIT 1;
        IF found_id IS NULL THEN
          INSERT INTO "workspace_role_definition" ("id", "workspace_id", "name", "permissions", "created_at", "updated_at")
          VALUES (
            gen_random_uuid()::text,
            m."workspaceId",
            pg_temp.wr_free_name(m."workspaceId", merged_name, merged_name),
            inter,
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
          )
          RETURNING "id" INTO found_id;
        END IF;
        final_role := 'member';          -- CUSTOM_WORKSPACE_ROLE_TIER
        final_def := found_id;
      END IF;
    END IF;

    UPDATE "workspace_membership" SET "workspace_role" = final_role, "role_definition_id" = final_def
    WHERE "id" = m."id";

    IF final_def IS NOT NULL THEN
      UPDATE _wr_counts SET custom = custom + 1 WHERE workspace_id = m."workspaceId";
    ELSIF final_role = 'member' THEN
      UPDATE _wr_counts SET members = members + 1 WHERE workspace_id = m."workspaceId";
    ELSE
      UPDATE _wr_counts SET viewers = viewers + 1 WHERE workspace_id = m."workspaceId";
    END IF;

    -- 5: one report row per reason.
    IF dropped THEN
      INSERT INTO "role_migration_report" ("id", "workspace_id", "user_id", "before_json", "after_role", "after_role_definition_id", "reason")
      VALUES (gen_random_uuid()::text, m."workspaceId", m."userId", before, final_role, final_def, 'project_role_dropped');
      UPDATE _wr_counts SET reported = reported + 1 WHERE workspace_id = m."workspaceId";
    END IF;
    IF chosen_reason IS NOT NULL THEN
      INSERT INTO "role_migration_report" ("id", "workspace_id", "user_id", "before_json", "after_role", "after_role_definition_id", "reason")
      VALUES (gen_random_uuid()::text, m."workspaceId", m."userId", before, final_role, final_def, chosen_reason);
      UPDATE _wr_counts SET reported = reported + 1 WHERE workspace_id = m."workspaceId";
    END IF;
  END LOOP;

  -- ── 6. The deploy log is the summary ──────────────────────────────────────
  FOR c IN SELECT * FROM _wr_counts ORDER BY workspace_id LOOP
    RAISE NOTICE 'MOTIR-6458: workspace % — % manager(s), % member(s), % viewer(s), % on a custom role, % report row(s)',
      c.workspace_id, c.managers, c.members, c.viewers, c.custom, c.reported;
  END LOOP;
END $$;

DROP FUNCTION pg_temp.wr_free_name(text, text, text);
DROP FUNCTION pg_temp.wr_norm(text[], text[]);
