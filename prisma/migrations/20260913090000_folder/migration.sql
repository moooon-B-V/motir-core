-- FOLDERS — named, nestable places in a project's tree that carry no workflow
-- (Epic MOTIR-5307 · Story MOTIR-5308 · MOTIR-5312).
--
-- A folder is its OWN record, not a work item, and a work item is filed into one
-- through a column of its own — `work_item."folderId"` — never through
-- `"parentId"`. That is the epic's central decision and this migration is where
-- it becomes a property of the schema rather than a convention:
--
--   * a filed item keeps `"parentId" IS NULL`, so readiness, status derivation,
--     the ready cascade, the roadmap root and every recursive walk over
--     `"parentId"` go on reading it as the root it is, untouched;
--   * the CHECK below makes "both a work-item parent AND a folder" a state the
--     database refuses, so an item is always in exactly one place.
--
-- WHAT THIS MIGRATION DOES
--   1. `folder` — the table, its indexes, its FKs (every one a Prisma
--      `@relation`, both sides, same actions — the FK-`@relation` rule).
--   2. `work_item."folderId"` + its index + FK + the parent-XOR-folder CHECK.
--   3. The sibling-name UNIQUE expression index (hand-written; see its note).
--   4. Tenancy triggers: a filed item's folder, and a folder's parent folder,
--      must share the row's workspace AND project. Plus a folder CYCLE backstop.
--   5. `enforce_work_item_kind_parent()` re-created so a SUBTASK may be a root
--      when it is filed in a folder — the epic's "any kind means any kind"
--      decision, which the shipped `WI_SUBTASK_NEEDS_PARENT` rule refused.
--   6. RLS on `folder` — the `work_item` policy pair, byte for byte in shape.
--
-- Existing rows: every `work_item` gets `"folderId" = NULL`. No backfill —
-- nothing is filed until a person files it.

-- 1. The folder table ---------------------------------------------------------
--
-- snake_case `@map` columns, the convention every table since `work_item_todo`
-- uses. (`work_item`'s own camelCase columns are its within-table convention,
-- which is why the column added to it below is `"folderId"`.)
CREATE TABLE "folder" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "parent_folder_id" TEXT,
    "name" TEXT NOT NULL,
    "position" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "folder_pkey" PRIMARY KEY ("id")
);

-- The LEVEL read: a project's folders under one parent (or the root), in order.
CREATE INDEX "folder_project_id_parent_folder_id_position_idx" ON "folder"("project_id", "parent_folder_id", "position");

-- As every tenant table carries.
CREATE INDEX "folder_workspace_id_idx" ON "folder"("workspace_id");

-- ON DELETE, one FK at a time:
--   * workspace_id / project_id  CASCADE — a deleted tenant's folders are not a
--     fact. (Projects are soft-archived in practice; `work_item.projectId` is
--     CASCADE for the same reason.)
--   * parent_folder_id  NO ACTION — the `work_item."parentId"` shape. Deleting
--     a folder that still holds child folders is refused by the database; the
--     service moves the children up first, in the same transaction.
--   * created_by_id  RESTRICT — the `work_item.reporter` shape: the creator is
--     durable attribution, exactly as a work item's reporter is.
ALTER TABLE "folder" ADD CONSTRAINT "folder_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "folder" ADD CONSTRAINT "folder_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "folder" ADD CONSTRAINT "folder_parent_folder_id_fkey" FOREIGN KEY ("parent_folder_id") REFERENCES "folder"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "folder" ADD CONSTRAINT "folder_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2. work_item."folderId" -----------------------------------------------------
ALTER TABLE "work_item" ADD COLUMN "folderId" TEXT;

-- A folder's level of filed work items, in order — the twin of
-- `work_item_projectId_parentId_position_idx`.
CREATE INDEX "work_item_projectId_folderId_position_idx" ON "work_item"("projectId", "folderId", "position");

-- NO ACTION, as `"parentId"` is: deleting a folder that still holds filed work
-- items is refused by the database, and the service files them up first.
ALTER TABLE "work_item" ADD CONSTRAINT "work_item_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "folder"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- An item is under a work item OR in a folder, never both. Prisma does not
-- model CHECK constraints and its differ does not propose dropping one.
ALTER TABLE "work_item" ADD CONSTRAINT "work_item_parent_xor_folder" CHECK ("parentId" IS NULL OR "folderId" IS NULL);

-- 3. Sibling names are unique, case-insensitively -----------------------------
--
-- A plain UNIQUE (project_id, parent_folder_id, name) would treat every NULL
-- parent as distinct and admit two root folders called "Later", and would admit
-- "Later" beside "later" everywhere. COALESCE folds the root into one sibling
-- group and lower() folds case.
--
-- This index is the RACE backstop: two people creating "Later" at the same
-- moment cannot both succeed. The service checks first for a friendly error and
-- translates this index's P2002 into the same typed error (MOTIR-5313).
--
-- Hand-written because Prisma cannot express an expression index. Its key is
-- made of EXPRESSIONS, so it shares no column list with the `@@index` above —
-- the CLAUDE.md rule about a hand-written index being paired to (and renamed
-- over) a datamodel index with the same columns cannot bite.
CREATE UNIQUE INDEX "folder_sibling_name_key" ON "folder"("project_id", COALESCE("parent_folder_id", ''), lower("name"));

-- 4. Tenancy + cycle triggers ---------------------------------------------------
--
-- All SECURITY DEFINER with `search_path` pinned, for the reason
-- 20260817160000_work_item_parent_tenancy records at length: the subject of a
-- tenancy check IS a row that may lie outside the invoking context, so as
-- SECURITY INVOKER the lookup reads NULL for exactly the write it exists to
-- refuse, takes the defer-to-the-FK branch, and the FK is then satisfied
-- because referential-integrity checks are exempt from RLS. The bodies read
-- two columns by primary key and return nothing; the only observable outputs
-- are the RAISEs, which name the tenancy of an id the caller supplied.

-- 4a. A filed work item's folder shares its workspace and project.
--     Markers translate at the repository edge (MOTIR-5313).
CREATE OR REPLACE FUNCTION enforce_work_item_folder_tenancy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  folder_workspace text;
  folder_project   text;
BEGIN
  IF NEW."folderId" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT f."workspace_id", f."project_id"
    INTO folder_workspace, folder_project
    FROM "folder" f
   WHERE f."id" = NEW."folderId";

  -- Folder genuinely missing: defer to the foreign key, which gives the
  -- clearer error. The lookup is unfiltered, so NULL means "no such row".
  IF folder_workspace IS NULL THEN
    RETURN NEW;
  END IF;

  IF folder_workspace <> NEW."workspaceId" THEN
    RAISE EXCEPTION 'WI_FOLDER_CROSS_WORKSPACE: folder % lives in workspace %, not % — a work item''s folder must belong to the same workspace',
      NEW."folderId", folder_workspace, NEW."workspaceId"
      USING ERRCODE = '23514';
  END IF;

  IF folder_project <> NEW."projectId" THEN
    RAISE EXCEPTION 'WI_FOLDER_CROSS_PROJECT: folder % lives in project %, not % — folders are project-local',
      NEW."folderId", folder_project, NEW."projectId"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

-- The NAME sorts directly after `trg_work_item_cotenancy` and before `_cycle` /
-- `_depth` / `_kind` (per-row BEFORE triggers fire alphabetically by name), so
-- a cross-tenant folder is refused before anything else reads the row.
CREATE TRIGGER trg_work_item_cotenancy_folder
  BEFORE INSERT OR UPDATE OF "folderId", "workspaceId", "projectId" ON "work_item"
  FOR EACH ROW EXECUTE FUNCTION enforce_work_item_folder_tenancy();

-- 4b. A folder's parent folder shares its workspace and project.
CREATE OR REPLACE FUNCTION enforce_folder_parent_tenancy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  parent_workspace text;
  parent_project   text;
BEGIN
  IF NEW."parent_folder_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT f."workspace_id", f."project_id"
    INTO parent_workspace, parent_project
    FROM "folder" f
   WHERE f."id" = NEW."parent_folder_id";

  IF parent_workspace IS NULL THEN
    RETURN NEW;
  END IF;

  IF parent_workspace <> NEW."workspace_id" THEN
    RAISE EXCEPTION 'FOLDER_PARENT_CROSS_WORKSPACE: parent folder % lives in workspace %, not % — a folder''s parent must belong to the same workspace',
      NEW."parent_folder_id", parent_workspace, NEW."workspace_id"
      USING ERRCODE = '23514';
  END IF;

  IF parent_project <> NEW."project_id" THEN
    RAISE EXCEPTION 'FOLDER_PARENT_CROSS_PROJECT: parent folder % lives in project %, not % — folders are project-local',
      NEW."parent_folder_id", parent_project, NEW."project_id"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_folder_cotenancy
  BEFORE INSERT OR UPDATE OF "parent_folder_id", "workspace_id", "project_id" ON "folder"
  FOR EACH ROW EXECUTE FUNCTION enforce_folder_parent_tenancy();

-- 4c. A folder cannot become its own ancestor.
--
-- The service refuses a cycle under a row lock with a typed error (MOTIR-5313);
-- this is the backstop `work_item` already has for `"parentId"`, so a direct SQL
-- write or a future path that forgets the check cannot tie the tree in a knot —
-- which every recursive ancestor walk would then loop on. Fires on UPDATE only:
-- an INSERT's id is new, so no existing row can have it as an ancestor.
-- Its name sorts after `trg_folder_cotenancy`, so a cross-tenant parent is
-- refused before this walk reads anything.
CREATE OR REPLACE FUNCTION enforce_folder_no_cycle()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  creates_cycle boolean;
BEGIN
  IF NEW."parent_folder_id" IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW."parent_folder_id" = NEW."id" THEN
    RAISE EXCEPTION 'FOLDER_PARENT_CYCLE: a folder cannot be its own parent'
      USING ERRCODE = '23514';
  END IF;

  WITH RECURSIVE chain AS (
    SELECT f."id", f."parent_folder_id", 1 AS lvl
      FROM "folder" f
      WHERE f."id" = NEW."parent_folder_id"
    UNION ALL
    SELECT f."id", f."parent_folder_id", c.lvl + 1
      FROM "folder" f
      JOIN chain c ON f."id" = c."parent_folder_id"
      WHERE c.lvl < 1000
  )
  SELECT EXISTS (SELECT 1 FROM chain WHERE "id" = NEW."id") INTO creates_cycle;

  IF creates_cycle THEN
    RAISE EXCEPTION 'FOLDER_PARENT_CYCLE: moving folder % under % would create a cycle', NEW."id", NEW."parent_folder_id"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_folder_cycle
  BEFORE UPDATE OF "parent_folder_id" ON "folder"
  FOR EACH ROW EXECUTE FUNCTION enforce_folder_no_cycle();

-- 5. A filed SUBTASK may be a root ----------------------------------------------
--
-- Epic MOTIR-5307: "Any kind means any kind. A `subtask`'s must-have-a-parent
-- rule is satisfied by a folder parent." The shipped function raised
-- WI_SUBTASK_NEEDS_PARENT on every root subtask, which would refuse filing one.
-- Body otherwise UNCHANGED from 20260817160000 (source of record:
-- prisma/sql/work_item_triggers.sql); still SECURITY DEFINER.
CREATE OR REPLACE FUNCTION enforce_work_item_kind_parent()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  item_kind   text := NEW."kind"::text;
  parent_kind text;
BEGIN
  IF NEW."parentId" IS NULL THEN
    -- A subtask is the only kind that may not be a root — unless it is filed in
    -- a folder, which satisfies its must-have-a-parent rule (MOTIR-5307).
    IF item_kind = 'subtask' AND NEW."folderId" IS NULL THEN
      RAISE EXCEPTION 'WI_SUBTASK_NEEDS_PARENT: a subtask must have a parent (story, task, or bug) or be filed in a folder'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- parentId is present from here on.
  IF item_kind = 'epic' THEN
    RAISE EXCEPTION 'WI_ILLEGAL_PARENT_TYPE: an epic must be top-level (parentId must be NULL)'
      USING ERRCODE = '23514';
  END IF;

  SELECT w."kind"::text INTO parent_kind FROM "work_item" w WHERE w."id" = NEW."parentId";

  -- Parent row missing: defer to the foreign-key constraint for a clear
  -- error rather than masking it with a parent-type rejection.
  IF parent_kind IS NULL THEN
    RETURN NEW;
  END IF;

  IF item_kind = 'story' AND parent_kind NOT IN ('epic') THEN
    RAISE EXCEPTION 'WI_ILLEGAL_PARENT_TYPE: a story may only be parented to an epic (got %)', parent_kind
      USING ERRCODE = '23514';
  ELSIF item_kind = 'task' AND parent_kind NOT IN ('epic', 'story') THEN
    RAISE EXCEPTION 'WI_ILLEGAL_PARENT_TYPE: a task may only be parented to an epic or story (got %)', parent_kind
      USING ERRCODE = '23514';
  ELSIF item_kind = 'bug' AND parent_kind NOT IN ('epic', 'story', 'task') THEN
    RAISE EXCEPTION 'WI_ILLEGAL_PARENT_TYPE: a bug may only be parented to an epic, story, or task (got %)', parent_kind
      USING ERRCODE = '23514';
  ELSIF item_kind = 'subtask' AND parent_kind NOT IN ('story', 'task', 'bug') THEN
    RAISE EXCEPTION 'WI_ILLEGAL_PARENT_TYPE: a subtask may only be parented to a story, task, or bug (got %)', parent_kind
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

-- The binding widens to `"folderId"`: clearing a root subtask's folder without
-- giving it a parent must still be refused, and an UPDATE touching only
-- `"folderId"` would not otherwise fire this trigger.
DROP TRIGGER trg_work_item_kind ON "work_item";
CREATE TRIGGER trg_work_item_kind
  BEFORE INSERT OR UPDATE OF "parentId", "kind", "folderId" ON "work_item"
  FOR EACH ROW EXECUTE FUNCTION enforce_work_item_kind_parent();

-- 6. RLS on folder ------------------------------------------------------------
--
-- The `work_item` pair (20260601074342_add_work_item_rls), for the same reasons:
--   * PERMISSIVE FOR ALL on the row's own `workspace_id` — RLS does not traverse
--     foreign keys, so tenancy is carried on the row; USING + WITH CHECK so a
--     write can neither place nor move a folder into a foreign workspace.
--   * RESTRICTIVE FOR SELECT narrowing to `app.project_id` when it is set —
--     AND-ed on, so it narrows and never widens; writes stay governed by the
--     workspace policy alone.
--
-- NO `app.system_admin` arm, deliberately — the `work_item_todo` reasoning: every
-- row has a non-null workspace and every write is a person acting inside one
-- workspace. An arm nobody needs is a hole nobody is watching.
--
-- `current_setting(..., true)` is missing_ok: no context ⇒ NULL ⇒ nothing
-- visible, the safe failure. The workspace RLS migration's
-- `ALTER DEFAULT PRIVILEGES` grants the app role on every new table, so no
-- explicit GRANT is needed.
ALTER TABLE "folder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "folder" FORCE ROW LEVEL SECURITY;

CREATE POLICY "folder_active_workspace" ON "folder"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

CREATE POLICY "folder_project_narrow" ON "folder"
  AS RESTRICTIVE
  FOR SELECT
  USING (
    coalesce(current_setting('app.project_id', true), '') = ''
    OR "project_id" = current_setting('app.project_id', true)
  );
