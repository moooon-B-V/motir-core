-- MOTIR-5820 — the project's PLANNER-BUG destination, as a pointer to a FOLDER.
-- ===========================================================================
-- Story MOTIR-5818. The `@planner-bug-home` marker used to resolve to a STORY
-- found by its title (`Captured planning-mistake bugs`), and that story became a
-- 400-child work item every read treats as open work — the shape MOTIR-5296
-- already retired for PRODUCT bugs. This column is the second destination,
-- mirroring `bug_destination_folder_id` (20260914200000_project_bug_destination_folder)
-- field for field. It adds NO readers: the resolver (MOTIR-5822), the delete
-- carry-up (MOTIR-5821), the picker (MOTIR-5823) and the data migration
-- (MOTIR-5824) are its siblings.
--
-- ---------------------------------------------------------------------------
-- `NULL` MEANS *FALL BACK*, NOT *BROKEN*
-- ---------------------------------------------------------------------------
--   a folder id -> file planner bugs into that folder
--   NULL        -> file them wherever PRODUCT bugs go (`bug_destination_folder_id`),
--                  and when that is NULL too, at the project root
--
-- Nullable, and **no default** — nothing seeds it. It stays NULL in every
-- project that does not deliberately set it, which is every project except
-- Motir's own. This migration reads and writes no data.
--
-- `ON DELETE NO ACTION`, the SECURITY DEFINER tenancy trigger and RLS are each
-- chosen for exactly the reasons the product pointer's migration records at
-- length; read them there rather than from a second copy here. In short: a
-- structural delete goes through `foldersService.deleteFolder`, which carries
-- the pointer to the folder's parent (MOTIR-5821); a composite FK cannot be a
-- Prisma relation, so same-project is a trigger; and the existing
-- `project_workspace_or_system_read` row policy already governs a new column.

-- 1. The column --------------------------------------------------------------
ALTER TABLE "project" ADD COLUMN "planner_bug_destination_folder_id" TEXT;

-- A folder delete checks `project` for referencing rows; declared as
-- `@@index([plannerBugDestinationFolderId])` in the datamodel too, or the
-- `build` job's `prisma migrate diff --exit-code` reports drift.
CREATE INDEX "project_planner_bug_destination_folder_id_idx" ON "project"("planner_bug_destination_folder_id");

ALTER TABLE "project"
  ADD CONSTRAINT "project_planner_bug_destination_folder_id_fkey"
  FOREIGN KEY ("planner_bug_destination_folder_id") REFERENCES "folder"("id")
  ON DELETE NO ACTION ON UPDATE CASCADE;

-- 2. The same-project check --------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_project_planner_bug_destination_folder_tenancy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  folder_workspace text;
  folder_project   text;
BEGIN
  -- NULL is the FALLBACK destination, and it is always legal.
  IF NEW."planner_bug_destination_folder_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT f."workspace_id", f."project_id"
    INTO folder_workspace, folder_project
    FROM "folder" f
   WHERE f."id" = NEW."planner_bug_destination_folder_id";

  -- Folder genuinely missing: defer to the foreign key, which gives the
  -- clearer error. The lookup is unfiltered, so NULL means "no such row".
  IF folder_workspace IS NULL THEN
    RETURN NEW;
  END IF;

  IF folder_workspace <> NEW."workspaceId" THEN
    RAISE EXCEPTION 'PROJECT_PLANNER_BUG_DESTINATION_FOLDER_CROSS_WORKSPACE: folder % lives in workspace %, not % — a project''s planner-bug destination must belong to the same workspace',
      NEW."planner_bug_destination_folder_id", folder_workspace, NEW."workspaceId"
      USING ERRCODE = '23514';
  END IF;

  IF folder_project <> NEW."id" THEN
    RAISE EXCEPTION 'PROJECT_PLANNER_BUG_DESTINATION_FOLDER_CROSS_PROJECT: folder % lives in project %, not % — folders are project-local',
      NEW."planner_bug_destination_folder_id", folder_project, NEW."id"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

-- Watches the pointer AND the project's own tenancy column, as the product
-- pointer's trigger does.
CREATE TRIGGER trg_project_planner_bug_destination_folder_tenancy
  BEFORE INSERT OR UPDATE OF "planner_bug_destination_folder_id", "workspaceId" ON "project"
  FOR EACH ROW EXECUTE FUNCTION enforce_project_planner_bug_destination_folder_tenancy();
