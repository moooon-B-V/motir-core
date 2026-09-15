-- MOTIR-4936 — BACKFILL every existing project with a Bugs FOLDER destination.
-- ===========================================================================
-- Story MOTIR-4927. New projects are born with a root folder named Bugs and a
-- destination pointing at it (MOTIR-4935). This gives every project that
-- already existed the same, once, on `prisma migrate deploy`, right after the
-- column was added (20260914200000_project_bug_destination_folder).
--
-- TWO POPULATIONS, told apart by READING each project, never by a date:
--
--   1. A project that already has a ROOT folder named bugs, in any case. Folder
--      names are unique per level ignoring case, so a second one could not be
--      created anyway: ADOPT it, and change nothing about the folder.
--   2. Every other project: create a root folder named Bugs, positioned after the
--      project's existing root folders, and point at it.
--
-- ONLY projects whose pointer is NULL are touched. On its single real run that
-- is every project (the column is new), and a second run finds every project
-- already pointed and writes nothing. It never runs again after deploy, so a
-- root a person later chooses in settings is never overwritten by it.
--
-- ARCHIVED projects are backfilled too, deliberately: an archived project can be
-- restored, and it must come back with a destination rather than a gap.
--
-- The folder's CREATOR is required (`folder.created_by_id`, Restrict) and a
-- project records none, so it is the workspace's earliest OWNER, else its
-- earliest member of any role. A workspace with no member at all cannot create
-- a folder and is skipped, leaving its projects at the root.
--
-- The name literal below MUST equal `DEFAULT_BUG_FOLDER_NAME` in
-- `lib/projects/bugDestination.ts` (SQL cannot import TS). The migration's test
-- asserts they match. It is a LABEL: nothing resolves the destination by it.
--
-- Positions append to the project's highest root folder key with a trailing
-- character, which sorts after it under the database's C.UTF-8 collation and is
-- a valid fractional-index key, the shape the planner-bug-home migration uses.
-- The planner-bug home story is not a destination and is not touched.

-- 1) Create the Bugs folder where a project has no root folder named bugs.
WITH needs_folder AS (
  SELECT p."id" AS pid, p."workspaceId" AS wid
  FROM "project" p
  WHERE p."bug_destination_folder_id" IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "folder" f
      WHERE f."project_id" = p."id"
        AND f."parent_folder_id" IS NULL
        AND lower(f."name") = 'bugs'
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
  gen_random_uuid()::text, nf.wid, nf.pid, NULL, 'Bugs',
  COALESCE(
    (SELECT MAX(f."position") FROM "folder" f
      WHERE f."project_id" = nf.pid AND f."parent_folder_id" IS NULL),
    'a0'
  ) || 'V',
  c.uid, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM needs_folder nf
JOIN creator c ON c.pid = nf.pid;

-- 2) Point every still-unpointed project at its root folder named bugs, the one
--    step 1 just created or the one it already had.
UPDATE "project" p
SET "bug_destination_folder_id" = f."id"
FROM "folder" f
WHERE p."bug_destination_folder_id" IS NULL
  AND f."project_id" = p."id"
  AND f."parent_folder_id" IS NULL
  AND lower(f."name") = 'bugs';
