-- Ensure the PLANNER-BUG HOME (Epic + Story) exists in the meta tenant (MOTIR-1466).
--
-- The AI self-learning loop (MOTIR-965) files `kind: bug`s under a home story,
-- targeted by the `@planner-bug-home` marker which `aiWorkItemsService.fileBug`
-- resolves via the home EPIC's title → its first child story. This migration is
-- the DURABLE, NON-DESTRUCTIVE way that home is provisioned into the deployed
-- meta tenant: an idempotent, guarded data backfill applied by the standard
-- `prisma migrate deploy` on every deploy — NOT a `pnpm db:seed` reseed (which
-- clear-and-rebuilds the whole tenant and cascade-deletes MCP-created items +
-- the workspace PAT — never run against the live tenant). It mirrors the
-- `add_organization_is_meta` data-flip: keyed on a stable marker (the meta org +
-- the epic title), idempotent (find-or-create), and a NO-OP on any DB whose meta
-- tenant is absent (fresh / CI / preview) or already has the home.
--
-- `migrate deploy` runs a migration EXACTLY ONCE per database, so this is a
-- one-shot BACKFILL of an already-existing tenant — not a per-deploy guarantee.
-- On the current live tenant the home already exists, so both statements below
-- find their target present and insert 0 rows.
--
-- Titles are string literals here (SQL cannot import TS); they MUST stay in sync
-- with `lib/ai/plannerBugHome.ts` (PLANNER_BUG_HOME_EPIC_TITLE /
-- PLANNER_BUG_HOME_STORY_TITLE). `tests/integration/migrations/ensure-planner-bug-home.test.ts`
-- asserts they match, catching drift.
--
-- Reporter: the seeded Motir system principal (system@motir.internal), the same
-- non-loginnable identity the bug-filer writes as. Resolved by a JOIN, so if it
-- is absent the SELECT yields no rows and nothing is inserted (never an error).
-- Keys come from the project's `lastWorkItemNumber` counter (the same allocator
-- the app uses). Positions append to the current max fractional-index key so they
-- are valid, globally unique, and sort last (never a padded/head-'0' key that
-- would break board drag). The kind-parent triggers (epic = root, story → epic)
-- validate both inserts.

-- 1) The home EPIC — create it if the meta tenant has no epic with this title.
WITH meta_project AS (
  SELECT p."id" AS pid, p."workspaceId" AS wid, p."identifier" AS pidentifier
  FROM "project" p
  JOIN "workspace" w ON w."id" = p."workspaceId"
  JOIN "organization" o ON o."id" = w."organizationId"
  WHERE o."isMeta" = true AND p."name" = 'motir'
  ORDER BY p."createdAt" ASC
  LIMIT 1
),
reporter AS (
  SELECT u."id" AS uid FROM "user" u WHERE u."email" = 'system@motir.internal' LIMIT 1
),
need_epic AS (
  SELECT mp.pid, mp.wid, mp.pidentifier, r.uid
  FROM meta_project mp
  JOIN reporter r ON true
  WHERE NOT EXISTS (
    SELECT 1 FROM "work_item" wi
    WHERE wi."projectId" = mp.pid
      AND wi."kind" = 'epic'
      AND wi."title" = 'Planner self-improvement — auto-reported quality bugs'
  )
),
alloc AS (
  UPDATE "project" p SET "lastWorkItemNumber" = p."lastWorkItemNumber" + 1
  FROM need_epic ne WHERE p."id" = ne.pid
  RETURNING p."id" AS pid, p."lastWorkItemNumber" AS n
),
maxpos AS (
  SELECT COALESCE(MAX(wi."position"), 'a0') AS mp
  FROM "work_item" wi JOIN need_epic ne ON wi."projectId" = ne.pid
)
INSERT INTO "work_item" (
  "id", "workspaceId", "projectId", "parentId", "kind", "key", "identifier",
  "title", "status", "priority", "reporterId", "position", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid()::text, ne.wid, ne.pid, NULL, 'epic'::"work_item_kind", a.n,
  ne.pidentifier || '-' || a.n,
  'Planner self-improvement — auto-reported quality bugs',
  'todo', 'medium'::"work_item_priority", ne.uid,
  (SELECT mp FROM maxpos) || 'V', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM need_epic ne JOIN alloc a ON a.pid = ne.pid;

-- 2) The home STORY — create it under the home epic if that epic has no story
--    child yet. Runs after (1), so it sees an epic (1) may have just created.
WITH meta_project AS (
  SELECT p."id" AS pid, p."identifier" AS pidentifier
  FROM "project" p
  JOIN "workspace" w ON w."id" = p."workspaceId"
  JOIN "organization" o ON o."id" = w."organizationId"
  WHERE o."isMeta" = true AND p."name" = 'motir'
  ORDER BY p."createdAt" ASC
  LIMIT 1
),
home_epic AS (
  SELECT wi."id" AS epic_id, wi."projectId" AS pid, wi."workspaceId" AS wid, mp.pidentifier
  FROM "work_item" wi
  JOIN meta_project mp ON wi."projectId" = mp.pid
  WHERE wi."kind" = 'epic'
    AND wi."title" = 'Planner self-improvement — auto-reported quality bugs'
  ORDER BY wi."key" ASC
  LIMIT 1
),
reporter AS (
  SELECT u."id" AS uid FROM "user" u WHERE u."email" = 'system@motir.internal' LIMIT 1
),
need_story AS (
  SELECT he.epic_id, he.pid, he.wid, he.pidentifier, r.uid
  FROM home_epic he
  JOIN reporter r ON true
  WHERE NOT EXISTS (
    SELECT 1 FROM "work_item" s WHERE s."parentId" = he.epic_id AND s."kind" = 'story'
  )
),
alloc AS (
  UPDATE "project" p SET "lastWorkItemNumber" = p."lastWorkItemNumber" + 1
  FROM need_story ns WHERE p."id" = ns.pid
  RETURNING p."id" AS pid, p."lastWorkItemNumber" AS n
),
maxpos AS (
  SELECT COALESCE(MAX(wi."position"), 'a0') AS mp
  FROM "work_item" wi JOIN need_story ns ON wi."projectId" = ns.pid
)
INSERT INTO "work_item" (
  "id", "workspaceId", "projectId", "parentId", "kind", "key", "identifier",
  "title", "status", "priority", "reporterId", "position", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid()::text, ns.wid, ns.pid, ns.epic_id, 'story'::"work_item_kind", a.n,
  ns.pidentifier || '-' || a.n,
  'Captured planning-mistake bugs',
  'todo', 'medium'::"work_item_priority", ns.uid,
  (SELECT mp FROM maxpos) || 'V', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM need_story ns JOIN alloc a ON a.pid = ns.pid;
