-- MOTIR-4934 — the project's BUG DESTINATION, as a pointer to a FOLDER.
-- ===========================================================================
-- Story MOTIR-4927, re-scoped 2026-09-14. The first version of this card
-- pointed `project` at a WORK ITEM (a seeded `task` container). That design is
-- superseded on the record: MOTIR-5296 decided the holder must not be a work
-- item, and folders (Epic MOTIR-5307, `20260913090000_folder`) exist to be
-- exactly that — a placement with no status, no edges and no rollup. This
-- migration adds the column the seed (MOTIR-4935), the backfill (MOTIR-4936),
-- the resolver (MOTIR-4937), the delete re-point (MOTIR-5537) and the settings
-- picker (MOTIR-4938) read and write. It adds NO readers.
--
-- ---------------------------------------------------------------------------
-- `NULL` IS A VALUE, NOT AN ABSENCE
-- ---------------------------------------------------------------------------
--   a folder id -> file bugs into that folder
--   NULL        -> file bugs at the PROJECT ROOT, unplaced
--
-- The root is a choice a person makes in project settings. So: nullable, and
-- **no default**. A later migration that adds one, or makes the column
-- required "for safety", silently overwrites every team that chose the root.
--
-- ---------------------------------------------------------------------------
-- WHY `ON DELETE NO ACTION`, AND NOT `SET NULL`
-- ---------------------------------------------------------------------------
-- The `folder."parent_folder_id"` shape (20260913090000_folder), for the same
-- reason: a structural delete goes through the SERVICE, never through the
-- database's own action. `foldersService.deleteFolder` moves a folder's
-- contents to its parent under `lockStructure`, and MOTIR-5537 makes it carry
-- this pointer to the same parent in the same transaction. A raw delete that
-- bypasses the service fails loudly instead.
--
-- `SET NULL` was the first version's choice and is the wrong one here: NULL
-- means *root, chosen*, so it would turn a deleted NESTED folder into a choice
-- nobody made — exactly the defect MOTIR-5294 recorded. Deleting a PROJECT is
-- unaffected: the project row and its folders go in one cascade, and a
-- NO ACTION check runs at the end of that statement, when both are gone.
--
-- ---------------------------------------------------------------------------
-- WHY A TRIGGER FOR THE SAME-PROJECT CHECK, AND WHY `SECURITY DEFINER`
-- ---------------------------------------------------------------------------
-- A folder is project-local (the folder migration's own words), so a project
-- may only point at one of its own. A composite FK would express it but cannot
-- be modelled as a Prisma relation, and a raw-SQL-only FK is the drift
-- CLAUDE.md forbids. So it is the trigger shape `enforce_folder_parent_tenancy`
-- and `enforce_work_item_folder_tenancy` already use: SECURITY DEFINER with a
-- pinned search_path, because the subject of a tenancy check is a row that may
-- lie OUTSIDE the invoking context — as SECURITY INVOKER the lookup would read
-- NULL for exactly the write it exists to refuse, take the defer-to-the-FK
-- branch, and the FK would then be satisfied (RI checks are exempt from RLS).
-- The body reads two columns by primary key; its only observable outputs are
-- the RAISEs, which name the tenancy of an id the caller supplied.
--
-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- NOTHING IS ADDED. `project_workspace_or_system_read` is PERMISSIVE `FOR ALL`
-- over the ROW with a WITH CHECK pinning `"workspaceId"` to the bound
-- workspace, so a new column on that row is governed the moment it exists.
-- Asserted in both directions by `tests/projects/bugDestinationFolderColumn.test.ts`.

-- 1. The column --------------------------------------------------------------
ALTER TABLE "project" ADD COLUMN "bug_destination_folder_id" TEXT;

-- A folder delete checks `project` for referencing rows; declared as
-- `@@index([bugDestinationFolderId])` in the datamodel too, or the `build`
-- job's `prisma migrate diff --exit-code` reports drift.
CREATE INDEX "project_bug_destination_folder_id_idx" ON "project"("bug_destination_folder_id");

ALTER TABLE "project"
  ADD CONSTRAINT "project_bug_destination_folder_id_fkey"
  FOREIGN KEY ("bug_destination_folder_id") REFERENCES "folder"("id")
  ON DELETE NO ACTION ON UPDATE CASCADE;

-- 2. The same-project check --------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_project_bug_destination_folder_tenancy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  folder_workspace text;
  folder_project   text;
BEGIN
  -- NULL is the ROOT destination, and it is always legal.
  IF NEW."bug_destination_folder_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT f."workspace_id", f."project_id"
    INTO folder_workspace, folder_project
    FROM "folder" f
   WHERE f."id" = NEW."bug_destination_folder_id";

  -- Folder genuinely missing: defer to the foreign key, which gives the
  -- clearer error. The lookup is unfiltered, so NULL means "no such row".
  IF folder_workspace IS NULL THEN
    RETURN NEW;
  END IF;

  IF folder_workspace <> NEW."workspaceId" THEN
    RAISE EXCEPTION 'PROJECT_BUG_DESTINATION_FOLDER_CROSS_WORKSPACE: folder % lives in workspace %, not % — a project''s bug destination must belong to the same workspace',
      NEW."bug_destination_folder_id", folder_workspace, NEW."workspaceId"
      USING ERRCODE = '23514';
  END IF;

  IF folder_project <> NEW."id" THEN
    RAISE EXCEPTION 'PROJECT_BUG_DESTINATION_FOLDER_CROSS_PROJECT: folder % lives in project %, not % — folders are project-local',
      NEW."bug_destination_folder_id", folder_project, NEW."id"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

-- Watches the pointer AND the project's own tenancy column: the invariant
-- breaks if the pointer moves, or if `workspaceId` moves under a stationary
-- pointer. (`project."id"` is the primary key and cannot move; a folder's own
-- `project_id` has no write path that changes it.)
CREATE TRIGGER trg_project_bug_destination_folder_tenancy
  BEFORE INSERT OR UPDATE OF "bug_destination_folder_id", "workspaceId" ON "project"
  FOR EACH ROW EXECUTE FUNCTION enforce_project_bug_destination_folder_tenancy();
