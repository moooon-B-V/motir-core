-- MOTIR-5919 — RE-RUN the planner-bug folder migration, keyed by the project's
-- IDENTIFIER instead of its name.
-- ===========================================================================
-- `20260919210100_file_planner_bugs_into_folder` (MOTIR-5824) scoped every
-- statement on `p."name" = 'motir'`. The deployed meta project is named `Motir`
-- and `=` on text is case-sensitive, so in production it matched nothing: no
-- pointer, the home story kept its children and was never archived (read on
-- the deployed tenant by MOTIR-5829). That migration is applied and is left as
-- it is; this one does the same four steps with a key that holds.
--
-- THE KEY: the meta organisation's project whose `identifier` is `MOTIR`. The
-- identifier is unique per workspace and is what the `@planner-bug-home` marker
-- is filed against, where a display name can be renamed, re-cased or
-- translated at any time. `isMeta` still gates it, so a customer project that
-- happens to carry the identifier `MOTIR` is never touched.
--
-- IDEMPOTENT, and a no-op wherever the previous migration already did the work
-- (a dev database whose project really was named `motir`): every statement is
-- guarded on the state it creates — the folder exists, the pointer is set, the
-- story has no children, the story is archived.
--
-- ⚠️ THE VERB IS ARCHIVE, NEVER `done` OR `cancelled`. Completing a container
-- cascades `done` onto every child (`childStatusCascadeService`); archive does
-- not cascade, and the children leave first (step 3) so the story is empty
-- before anything happens to it. NO status is written by this migration.
--
-- The story title literal MUST equal `PLANNER_BUG_HOME_STORY_TITLE` in
-- `lib/ai/plannerBugHome.ts`. In production the `Planning bugs` folder already
-- exists under `Bugs` (created by hand on 2026-09-19), so step 1 ADOPTS it.
-- `tests/integration/migrations/file-planner-bugs-into-folder-by-identifier.test.ts`
-- seeds that deployed shape and asserts the literals.

-- 1) ADOPT or CREATE the `Planning bugs` folder under the project's product bug
--    destination (the project root when that is NULL). An existing one, any
--    case, is adopted and never duplicated. The creator is the workspace's
--    earliest OWNER, else its earliest member of any role.
WITH home AS (
  SELECT wi."id" AS sid, p."id" AS pid, p."workspaceId" AS wid,
         p."bug_destination_folder_id" AS parent
  FROM "project" p
  JOIN "workspace" w ON w."id" = p."workspaceId"
  JOIN "organization" o ON o."id" = w."organizationId"
  JOIN "work_item" wi ON wi."projectId" = p."id"
                     AND wi."kind" = 'story'
                     AND wi."title" = 'Captured planning-mistake bugs'
  WHERE o."isMeta" = true AND p."identifier" = 'MOTIR'
    AND p."planner_bug_destination_folder_id" IS NULL
),
needs_folder AS (
  SELECT DISTINCT h.pid, h.wid, h.parent
  FROM home h
  WHERE NOT EXISTS (
    SELECT 1 FROM "folder" f
    WHERE f."project_id" = h.pid
      AND f."parent_folder_id" IS NOT DISTINCT FROM h.parent
      AND lower(f."name") = 'planning bugs'
  )
),
creator AS (
  SELECT DISTINCT ON (nf.pid) nf.pid, wm."userId" AS uid
  FROM needs_folder nf
  JOIN "workspace_membership" wm ON wm."workspaceId" = nf.wid
  ORDER BY nf.pid, (wm."role" = 'owner'::"member_role") DESC, wm."createdAt" ASC
)
INSERT INTO "folder" (
  "id", "workspace_id", "project_id", "parent_folder_id", "name", "position",
  "created_by_id", "created_at", "updated_at"
)
SELECT
  gen_random_uuid()::text, nf.wid, nf.pid, nf.parent, 'Planning bugs',
  COALESCE(
    (SELECT MAX(f."position") FROM "folder" f
      WHERE f."project_id" = nf.pid
        AND f."parent_folder_id" IS NOT DISTINCT FROM nf.parent),
    'a0'
  ) || 'V',
  c.uid, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM needs_folder nf
JOIN creator c ON c.pid = nf.pid;

-- 2) POINT the project's planner-bug destination at that folder — only where it
--    is still NULL, so a destination somebody chose is never overwritten.
UPDATE "project" p
SET "planner_bug_destination_folder_id" = f."id"
FROM "workspace" w, "organization" o, "folder" f
WHERE w."id" = p."workspaceId"
  AND o."id" = w."organizationId"
  AND o."isMeta" = true AND p."identifier" = 'MOTIR'
  AND p."planner_bug_destination_folder_id" IS NULL
  AND EXISTS (
    SELECT 1 FROM "work_item" wi
    WHERE wi."projectId" = p."id"
      AND wi."kind" = 'story'
      AND wi."title" = 'Captured planning-mistake bugs'
  )
  AND f."project_id" = p."id"
  AND f."parent_folder_id" IS NOT DISTINCT FROM p."bug_destination_folder_id"
  AND lower(f."name") = 'planning bugs';

-- 3) MOVE every child of the home story into the planner-bug destination:
--    `folderId` set, `parentId` nulled, in one statement. Status, position and
--    every other column are left as they are.
UPDATE "work_item" child
SET "folderId" = p."planner_bug_destination_folder_id",
    "parentId" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
FROM "work_item" story, "project" p, "workspace" w, "organization" o
WHERE child."parentId" = story."id"
  AND story."kind" = 'story'
  AND story."title" = 'Captured planning-mistake bugs'
  AND p."id" = story."projectId"
  AND w."id" = p."workspaceId"
  AND o."id" = w."organizationId"
  AND o."isMeta" = true AND p."identifier" = 'MOTIR'
  AND p."planner_bug_destination_folder_id" IS NOT NULL;

-- 4) ARCHIVE the story, now that it is empty. Guarded on emptiness and on
--    `archivedAt`, so it can never archive a story whose children did not move
--    and a second run writes nothing. Its status is NOT touched.
UPDATE "work_item" story
SET "archivedAt" = CURRENT_TIMESTAMP,
    "updatedAt" = CURRENT_TIMESTAMP
FROM "project" p, "workspace" w, "organization" o
WHERE story."kind" = 'story'
  AND story."title" = 'Captured planning-mistake bugs'
  AND story."archivedAt" IS NULL
  AND p."id" = story."projectId"
  AND w."id" = p."workspaceId"
  AND o."id" = w."organizationId"
  AND o."isMeta" = true AND p."identifier" = 'MOTIR'
  AND p."planner_bug_destination_folder_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "work_item" c WHERE c."parentId" = story."id");
