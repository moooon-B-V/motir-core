-- PAGE ↔ WORK ITEM LINKS — the rows a page body names, and later the hand-made
-- ones (Epic MOTIR-5747 · Story MOTIR-7565 · MOTIR-7571).
--
-- `docs/decisions/pages.md` §8.1 fixes the shape: `id`, `workspace_id`,
-- `project_id`, `page_id`, `work_item_id`, `source`, `created_by_id`,
-- `created_at`, unique on `(page_id, work_item_id, source)`, page and work item
-- in the same project. `mention` and `embed` rows are DERIVED from the body on
-- every save (`@motir/pages` `extractLinks` → `replaceDerivedLinks`, in the
-- save's transaction); `manual` rows are written by an explicit action and a
-- body write never touches one.
--
-- WHAT THIS MIGRATION DOES
--   1. The `page_work_item_link_source` enum and the table, its unique key and
--      the reverse-read index.
--   2. Its foreign keys.
--   3. Its cotenancy trigger: the page and the work item share the row's
--      workspace and project.
--   4. RLS — the `page` pair.
--
-- EXPAND-ONLY: a new enum and a new table. Nothing reads it before the code that
-- ships beside it, and nothing back-fills it: a page's rows appear on its next
-- save.

-- 1. The table ----------------------------------------------------------------------------
CREATE TYPE "page_work_item_link_source" AS ENUM ('mention', 'embed', 'manual');

CREATE TABLE "page_work_item_link" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "page_id" TEXT NOT NULL,
    "work_item_id" TEXT NOT NULL,
    "source" "page_work_item_link_source" NOT NULL,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_work_item_link_pkey" PRIMARY KEY ("id")
);

-- A work item named three times on one page is ONE row per source.
CREATE UNIQUE INDEX "page_work_item_link_page_id_work_item_id_source_key" ON "page_work_item_link"("page_id", "work_item_id", "source");

-- The reverse read: the pages that link one work item.
CREATE INDEX "page_work_item_link_work_item_id_page_id_idx" ON "page_work_item_link"("work_item_id", "page_id");

CREATE INDEX "page_work_item_link_workspace_id_idx" ON "page_work_item_link"("workspace_id");

-- 2. Foreign keys -------------------------------------------------------------------------
--
-- ON DELETE, one FK at a time:
--   * workspace_id / project_id  CASCADE — the rows go with their tenant.
--   * page_id  CASCADE — a page's permanent delete takes its rows. ARCHIVING a
--     page deletes nothing: the read filters archived pages out.
--   * work_item_id  CASCADE — a work item's hard delete takes its rows; archiving
--     one keeps them, so a restore needs no re-derivation.
--   * created_by_id  SET NULL — deleting the user forgets who first linked it,
--     never the link.
ALTER TABLE "page_work_item_link" ADD CONSTRAINT "page_work_item_link_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "page_work_item_link" ADD CONSTRAINT "page_work_item_link_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "page_work_item_link" ADD CONSTRAINT "page_work_item_link_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "page_work_item_link" ADD CONSTRAINT "page_work_item_link_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "page_work_item_link" ADD CONSTRAINT "page_work_item_link_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 3. The cotenancy trigger ------------------------------------------------------------------
--
-- SECURITY DEFINER with `search_path` pinned, for the reason the page migrations
-- give: the rows a tenancy check reads may lie outside the invoking RLS context,
-- and as SECURITY INVOKER the lookup would read NULL for exactly the write it
-- exists to refuse. It reads by primary key and returns nothing; the only
-- observable outputs are the RAISEs.
CREATE OR REPLACE FUNCTION enforce_page_work_item_link_cotenancy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  page_workspace text;
  page_project   text;
  item_workspace text;
  item_project   text;
BEGIN
  SELECT p."workspace_id", p."project_id"
    INTO page_workspace, page_project
    FROM "page" p
   WHERE p."id" = NEW."page_id";

  -- Missing: defer to the foreign key, which gives the clearer error.
  IF page_workspace IS NOT NULL
     AND (page_workspace <> NEW."workspace_id" OR page_project <> NEW."project_id") THEN
    RAISE EXCEPTION 'PAGE_LINK_PAGE_CROSS_PROJECT: page % lives in project %, not % — a link belongs to its page''s project',
      NEW."page_id", page_project, NEW."project_id"
      USING ERRCODE = '23514';
  END IF;

  -- `work_item`'s columns are camelCase (it predates the snake_case mapping).
  SELECT w."workspaceId", w."projectId"
    INTO item_workspace, item_project
    FROM "work_item" w
   WHERE w."id" = NEW."work_item_id";

  IF item_project IS NOT NULL
     AND (item_workspace <> NEW."workspace_id" OR item_project <> NEW."project_id") THEN
    RAISE EXCEPTION 'PAGE_LINK_ITEM_CROSS_PROJECT: work item % lives in project %, not % — a page links only work items of its own project',
      NEW."work_item_id", item_project, NEW."project_id"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_page_work_item_link_cotenancy
  BEFORE INSERT OR UPDATE OF "workspace_id", "project_id", "page_id", "work_item_id" ON "page_work_item_link"
  FOR EACH ROW EXECUTE FUNCTION enforce_page_work_item_link_cotenancy();

-- 4. RLS on page_work_item_link ----------------------------------------------------------
--
-- The `page` pair: PERMISSIVE FOR ALL on the row's own `workspace_id`, and
-- RESTRICTIVE FOR SELECT narrowing to `app.project_id` when it is set.
ALTER TABLE "page_work_item_link" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "page_work_item_link" FORCE ROW LEVEL SECURITY;

CREATE POLICY "page_work_item_link_active_workspace" ON "page_work_item_link"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

CREATE POLICY "page_work_item_link_project_narrow" ON "page_work_item_link"
  AS RESTRICTIVE
  FOR SELECT
  USING (
    coalesce(current_setting('app.project_id', true), '') = ''
    OR "project_id" = current_setting('app.project_id', true)
  );
