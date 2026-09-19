-- MOTIR-5824 — FILE the planner's own bugs into a `Planning bugs` FOLDER and
-- retire the story they lived under.
-- ===========================================================================
-- Story MOTIR-5818. The `@planner-bug-home` marker now FILES into the project's
-- planner-bug destination folder (MOTIR-5822, the column is MOTIR-5820). This
-- moves the corpus already filed under the OLD home — the story titled
-- `Captured planning-mistake bugs` — to where new ones now land, and ARCHIVES
-- the emptied story.
--
-- SCOPE: the meta tenant's `motir` project only, keyed exactly as
-- `20260701130000_ensure_planner_bug_home` keyed the home it created (the meta
-- organisation, the project named `motir`). A database with no meta tenant, or
-- whose meta project has no such story, matches nothing and every statement
-- writes 0 rows — which is every customer database, every fresh one and CI.
--
-- IDEMPOTENT: every statement is guarded on the state it creates, so a second
-- run is a no-op (the folder exists, the pointer is set, the story has no
-- children, the story is archived).
--
-- ⚠️ THE VERB IS ARCHIVE, NEVER `done` OR `cancelled`. Completing a container
-- cascades `done` onto every child from any status, by a system write no
-- interactive edge allows (`childStatusCascadeService`); archive does not
-- cascade. And the ORDER backs the verb up: the children leave FIRST (step 3),
-- so even a mistaken close of the story would have nothing left to reach.
-- NO child's status is written by this migration.
--
-- The story title literal MUST equal `PLANNER_BUG_HOME_STORY_TITLE` in
-- `lib/ai/plannerBugHome.ts` (SQL cannot import TS), and the folder name is a
-- LABEL read once, to ADOPT an existing row — exactly as the product
-- destination's backfill (20260914200100) reads `Bugs`. Nothing resolves the
-- destination by that name afterwards: the pointer is by id.
-- `tests/integration/migrations/file-planner-bugs-into-folder.test.ts` asserts
-- both literals.

-- 1) ADOPT or CREATE the `Planning bugs` folder under the project's product bug
--    destination (the project root when that is NULL). Folder names are unique
--    per level ignoring case, so an existing one is adopted, never duplicated.
--    Created only for a project that HAS the home story and has no planner-bug
--    pointer yet. The folder's creator is required and a project records none:
--    the workspace's earliest OWNER, else its earliest member of any role.
WITH home AS (
  SELECT wi."id" AS sid, p."id" AS pid, p."workspaceId" AS wid,
         p."bug_destination_folder_id" AS parent
  FROM "project" p
  JOIN "workspace" w ON w."id" = p."workspaceId"
  JOIN "organization" o ON o."id" = w."organizationId"
  JOIN "work_item" wi ON wi."projectId" = p."id"
                     AND wi."kind" = 'story'
                     AND wi."title" = 'Captured planning-mistake bugs'
  WHERE o."isMeta" = true AND p."name" = 'motir'
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
  AND o."isMeta" = true AND p."name" = 'motir'
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
--    `folderId` set, `parentId` nulled, in one statement. EVERY child — `done`
--    and archived ones included — because split history across two holders is
--    worse than either, and a folder has no rollup, so closed rows cost nothing
--    there. Status, position and every other column are left as they are.
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
  AND o."isMeta" = true AND p."name" = 'motir'
  AND p."planner_bug_destination_folder_id" IS NOT NULL;

-- 4) ARCHIVE the story, now that it is empty. Guarded on emptiness, so it can
--    never archive a story whose children did not move (a project step 2 could
--    not point), and on `archivedAt` so a second run writes nothing. Its status
--    is NOT touched.
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
  AND o."isMeta" = true AND p."name" = 'motir'
  AND p."planner_bug_destination_folder_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "work_item" c WHERE c."parentId" = story."id");
