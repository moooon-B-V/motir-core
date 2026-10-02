-- PAGES — a project's documents (Epic MOTIR-5746 · Story MOTIR-5752 · MOTIR-7273).
--
-- The schema `docs/decisions/pages.md` §3–§4 fixes, and the FIRST `bytea` column
-- in the schema. It follows `20260913090000_folder` clause for clause: the same
-- FK actions, the same SECURITY DEFINER tenancy and cycle backstops, the same
-- RLS pair.
--
-- WHAT THIS MIGRATION DOES
--   1. `page` — the table, its indexes and FKs (every one a Prisma `@relation`,
--      both sides, same actions — the FK-`@relation` rule).
--   2. The two CHECKs: a page sits under a page OR in a folder (never both), and
--      no deeper than 10 levels of pages.
--   3. Tenancy + cycle triggers: a page's parent page and folder share its
--      workspace and project, and a page cannot become its own ancestor.
--   4. RLS on `page` — the `folder` policy pair, byte for byte in shape.
--
-- NOT HERE, each with the card that first writes it: the archive columns
-- (MOTIR-5755), `page_version` (MOTIR-5754), `page_work_item_link` (the linking
-- epic), and `attachment.page_id` (the page images card, MOTIR-7279).

-- 1. The page table -----------------------------------------------------------
--
-- The body (§3): `body_state` is the canonical Yjs document — the encoding of
-- `Y.encodeStateAsUpdate(doc)` — and the three formats beside it are DERIVED
-- from it in the same transaction as every save. Nothing reads a derived column
-- to produce the canonical one. `revision` counts saves, 1 at creation.
--
-- The tree (§4): `parent_page_id` and `folder_id`, both null at the root;
-- `ancestor_page_ids` holds the page ids root-first, excluding the page itself,
-- for breadcrumbs and the depth limit; `position` is a fractional key among the
-- pages that share the parent.
CREATE TABLE "page" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "parent_page_id" TEXT,
    "folder_id" TEXT,
    "position" TEXT NOT NULL,
    "ancestor_page_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "body_state" BYTEA NOT NULL,
    "body_json" JSONB NOT NULL,
    "body_markdown" TEXT NOT NULL DEFAULT '',
    "body_text" TEXT NOT NULL DEFAULT '',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" TEXT NOT NULL,
    "updated_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "page_pkey" PRIMARY KEY ("id")
);

-- The LEVEL reads (§4): one parent's pages, or one folder's, in `(position, id)`
-- order — the keyset the level cursor pages on.
CREATE INDEX "page_project_id_parent_page_id_position_id_idx" ON "page"("project_id", "parent_page_id", "position", "id");

CREATE INDEX "page_project_id_folder_id_position_id_idx" ON "page"("project_id", "folder_id", "position", "id");

-- As every tenant table carries.
CREATE INDEX "page_workspace_id_idx" ON "page"("workspace_id");

-- ON DELETE, one FK at a time — the folder migration's choices:
--   * workspace_id / project_id  CASCADE — a deleted tenant's pages are not a fact.
--   * parent_page_id  NO ACTION — deleting a page that still holds sub-pages is
--     refused by the database; the service decides what happens to them first.
--   * folder_id  NO ACTION — `work_item."folderId"`'s shape: deleting a folder
--     that still holds pages is refused, and the folder service moves them up.
--   * created_by_id / updated_by_id  RESTRICT — durable attribution, the
--     `folder.created_by_id` shape.
ALTER TABLE "page" ADD CONSTRAINT "page_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "page" ADD CONSTRAINT "page_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "page" ADD CONSTRAINT "page_parent_page_id_fkey" FOREIGN KEY ("parent_page_id") REFERENCES "page"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "page" ADD CONSTRAINT "page_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "folder"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "page" ADD CONSTRAINT "page_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "page" ADD CONSTRAINT "page_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2. The CHECKs ---------------------------------------------------------------
--
-- A page is under a page OR in a folder, never both; both null is the root. The
-- `work_item_parent_xor_folder` precedent. There is no column that could point
-- at a work item, so "a page is never filed under a work item" is structural.
-- Prisma does not model CHECK constraints and its differ does not propose
-- dropping one.
ALTER TABLE "page" ADD CONSTRAINT "page_parent_xor_folder" CHECK (num_nonnulls("parent_page_id", "folder_id") <= 1);

-- At most 10 levels of pages (§4, `PAGE_DEPTH_LIMIT`): a root or folder-filed
-- page is level 1 and carries no ancestors, so level N carries N - 1.
ALTER TABLE "page" ADD CONSTRAINT "page_depth_limit" CHECK (cardinality("ancestor_page_ids") < 10);

-- 3. Tenancy + cycle triggers ---------------------------------------------------
--
-- SECURITY DEFINER with `search_path` pinned, for the reason the folder
-- migration repeats from 20260817160000_work_item_parent_tenancy: the subject
-- of a tenancy check is a row that may lie OUTSIDE the invoking context, so as
-- SECURITY INVOKER the lookup reads NULL for exactly the write it exists to
-- refuse, defers to the FK, and the FK is satisfied because referential checks
-- are exempt from RLS. The bodies read two columns by primary key and return
-- nothing; the only observable outputs are the RAISEs.

-- 3a. A page's parent page and folder share its workspace and project.
CREATE OR REPLACE FUNCTION enforce_page_cotenancy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  other_workspace text;
  other_project   text;
BEGIN
  IF NEW."parent_page_id" IS NOT NULL THEN
    SELECT p."workspace_id", p."project_id"
      INTO other_workspace, other_project
      FROM "page" p
     WHERE p."id" = NEW."parent_page_id";

    -- Missing: defer to the foreign key, which gives the clearer error.
    IF other_workspace IS NOT NULL THEN
      IF other_workspace <> NEW."workspace_id" THEN
        RAISE EXCEPTION 'PAGE_PARENT_CROSS_WORKSPACE: parent page % lives in workspace %, not % — a page''s parent must belong to the same workspace',
          NEW."parent_page_id", other_workspace, NEW."workspace_id"
          USING ERRCODE = '23514';
      END IF;
      IF other_project <> NEW."project_id" THEN
        RAISE EXCEPTION 'PAGE_PARENT_CROSS_PROJECT: parent page % lives in project %, not % — pages are project-local',
          NEW."parent_page_id", other_project, NEW."project_id"
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  IF NEW."folder_id" IS NOT NULL THEN
    other_workspace := NULL;
    other_project := NULL;
    SELECT f."workspace_id", f."project_id"
      INTO other_workspace, other_project
      FROM "folder" f
     WHERE f."id" = NEW."folder_id";

    IF other_workspace IS NOT NULL THEN
      IF other_workspace <> NEW."workspace_id" THEN
        RAISE EXCEPTION 'PAGE_FOLDER_CROSS_WORKSPACE: folder % lives in workspace %, not % — a page''s folder must belong to the same workspace',
          NEW."folder_id", other_workspace, NEW."workspace_id"
          USING ERRCODE = '23514';
      END IF;
      IF other_project <> NEW."project_id" THEN
        RAISE EXCEPTION 'PAGE_FOLDER_CROSS_PROJECT: folder % lives in project %, not % — folders are project-local',
          NEW."folder_id", other_project, NEW."project_id"
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Per-row BEFORE triggers fire alphabetically by name, so `_cotenancy` runs
-- before `_cycle`: a cross-tenant parent is refused before the walk reads it.
CREATE TRIGGER trg_page_cotenancy
  BEFORE INSERT OR UPDATE OF "parent_page_id", "folder_id", "workspace_id", "project_id" ON "page"
  FOR EACH ROW EXECUTE FUNCTION enforce_page_cotenancy();

-- 3b. A page cannot become its own ancestor.
--
-- The service refuses a cycle first, under `lockSiblings`, with
-- `PageCycleError`; this is the backstop the folder table has, so a direct SQL
-- write or a future path that forgets the check cannot tie the tree in a knot.
-- It walks `parent_page_id` rather than trusting `ancestor_page_ids`, because a
-- backstop that reads the denormalised array would believe whatever a buggy
-- writer put there. Fires on UPDATE only: an INSERT's id is new, so no existing
-- row can have it as an ancestor.
CREATE OR REPLACE FUNCTION enforce_page_no_cycle()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  creates_cycle boolean;
BEGIN
  IF NEW."parent_page_id" IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW."parent_page_id" = NEW."id" THEN
    RAISE EXCEPTION 'PAGE_PARENT_CYCLE: a page cannot be its own parent'
      USING ERRCODE = '23514';
  END IF;

  WITH RECURSIVE chain AS (
    SELECT p."id", p."parent_page_id", 1 AS lvl
      FROM "page" p
      WHERE p."id" = NEW."parent_page_id"
    UNION ALL
    SELECT p."id", p."parent_page_id", c.lvl + 1
      FROM "page" p
      JOIN chain c ON p."id" = c."parent_page_id"
      WHERE c.lvl < 1000
  )
  SELECT EXISTS (SELECT 1 FROM chain WHERE "id" = NEW."id") INTO creates_cycle;

  IF creates_cycle THEN
    RAISE EXCEPTION 'PAGE_PARENT_CYCLE: moving page % under % would create a cycle', NEW."id", NEW."parent_page_id"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_page_cycle
  BEFORE UPDATE OF "parent_page_id" ON "page"
  FOR EACH ROW EXECUTE FUNCTION enforce_page_no_cycle();

-- 4. RLS on page --------------------------------------------------------------
--
-- The `folder` pair, for the same reasons:
--   * PERMISSIVE FOR ALL on the row's own `workspace_id` — RLS does not traverse
--     foreign keys, so tenancy is carried on the row; USING + WITH CHECK so a
--     write can neither place nor move a page into a foreign workspace.
--   * RESTRICTIVE FOR SELECT narrowing to `app.project_id` when it is set.
--
-- No `app.system_admin` arm, as on `folder`. The workspace RLS migration's
-- `ALTER DEFAULT PRIVILEGES` grants the app role on every new table.
ALTER TABLE "page" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "page" FORCE ROW LEVEL SECURITY;

CREATE POLICY "page_active_workspace" ON "page"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

CREATE POLICY "page_project_narrow" ON "page"
  AS RESTRICTIVE
  FOR SELECT
  USING (
    coalesce(current_setting('app.project_id', true), '') = ''
    OR "project_id" = current_setting('app.project_id', true)
  );
