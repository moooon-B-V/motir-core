-- DECISION PAGES — a decision published as a page version, and the two marks a
-- version can carry (Epic MOTIR-5746 · Story MOTIR-5761 · MOTIR-7428).
--
-- `docs/decisions/approval-gates.md` §8 NINTH AMENDMENT and `docs/decisions/
-- pages.md` AMENDMENT 3. A version is SEALED by a publish (no save extends it)
-- and FROZEN by the gate that approved it (never extended, never pruned, and
-- its page cannot be deleted while it holds one). This migration only stores
-- the marks and the publication; `@motir/pages` and the gate services decide
-- when they are written.
--
-- WHAT THIS MIGRATION DOES
--   1. `page_version` gains `sealed_at`, `frozen_at` and `frozen_by_gate_id`,
--      and a CHECK that a frozen version was sealed first.
--   2. `decision_page_publication` — which version of which page a work item
--      published, by whom and when.
--   3. Its cotenancy trigger: the page, the version and the work item share the
--      row's workspace and project, and the version belongs to the page.
--   4. RLS — the `page` pair.
--
-- EXPAND-ONLY: nullable columns and a new table. Existing versions read both
-- marks NULL, and nothing reads them before the code that ships beside it.

-- 1. The marks on a version ----------------------------------------------------------
--
-- Timestamps rather than booleans, so the audit can say WHEN. `frozen_by_gate_id`
-- names the approval that froze it; SET NULL keeps the freeze if that gate row
-- is ever removed (it is removed only with its work item or tenant).
ALTER TABLE "page_version" ADD COLUMN "sealed_at" TIMESTAMP(3),
ADD COLUMN "frozen_at" TIMESTAMP(3),
ADD COLUMN "frozen_by_gate_id" TEXT;

ALTER TABLE "page_version" ADD CONSTRAINT "page_version_frozen_by_gate_id_fkey" FOREIGN KEY ("frozen_by_gate_id") REFERENCES "approval_gate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A frozen version was published first: the gate froze what a publish sealed.
ALTER TABLE "page_version" ADD CONSTRAINT "page_version_frozen_requires_sealed" CHECK ("frozen_at" IS NULL OR "sealed_at" IS NOT NULL);

-- 2. The publication -------------------------------------------------------------------
--
-- Append-only: one row per publish, and the newest row for a work item is its
-- published page. Nothing updates a row.
CREATE TABLE "decision_page_publication" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "work_item_id" TEXT NOT NULL,
    "page_id" TEXT NOT NULL,
    "page_version_id" TEXT NOT NULL,
    "published_by_id" TEXT NOT NULL,
    "published_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decision_page_publication_pkey" PRIMARY KEY ("id")
);

-- `latestForWorkItem`: the newest publication of one work item.
CREATE INDEX "decision_page_publication_work_item_id_published_at_idx" ON "decision_page_publication"("work_item_id", "published_at" DESC);

CREATE INDEX "decision_page_publication_page_version_id_idx" ON "decision_page_publication"("page_version_id");

CREATE INDEX "decision_page_publication_workspace_id_idx" ON "decision_page_publication"("workspace_id");

-- ON DELETE, one FK at a time:
--   * workspace_id / project_id / work_item_id / page_id  CASCADE — the
--     publication goes with any of them.
--   * page_version_id  NO ACTION — a published version must not be deleted on
--     its own (the cap never prunes a sealed one, and this is the backstop).
--     NO ACTION rather than RESTRICT: it is checked at the END of the statement,
--     so a page, project or workspace delete — which cascades through both the
--     version and the publication — still succeeds, whatever order the cascade
--     visits them in. RESTRICT is checked immediately and could refuse it.
--   * published_by_id  RESTRICT — durable attribution, as `page_version.author_id`.
ALTER TABLE "decision_page_publication" ADD CONSTRAINT "decision_page_publication_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "decision_page_publication" ADD CONSTRAINT "decision_page_publication_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "decision_page_publication" ADD CONSTRAINT "decision_page_publication_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "decision_page_publication" ADD CONSTRAINT "decision_page_publication_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "decision_page_publication" ADD CONSTRAINT "decision_page_publication_page_version_id_fkey" FOREIGN KEY ("page_version_id") REFERENCES "page_version"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "decision_page_publication" ADD CONSTRAINT "decision_page_publication_published_by_id_fkey" FOREIGN KEY ("published_by_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3. The cotenancy trigger ----------------------------------------------------------------
--
-- SECURITY DEFINER with `search_path` pinned, for the reason the page and
-- page-version migrations give: the rows a tenancy check reads may lie outside
-- the invoking RLS context, and as SECURITY INVOKER the lookup would read NULL
-- for exactly the write it exists to refuse. It reads by primary key and
-- returns nothing; the only observable outputs are the RAISEs.
CREATE OR REPLACE FUNCTION enforce_decision_page_publication_cotenancy()
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
  version_page   text;
BEGIN
  SELECT p."workspace_id", p."project_id"
    INTO page_workspace, page_project
    FROM "page" p
   WHERE p."id" = NEW."page_id";

  -- Missing: defer to the foreign key, which gives the clearer error.
  IF page_workspace IS NOT NULL
     AND (page_workspace <> NEW."workspace_id" OR page_project <> NEW."project_id") THEN
    RAISE EXCEPTION 'DECISION_PAGE_CROSS_PROJECT: page % lives in project %, not % — a decision page belongs to its work item''s project',
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
    RAISE EXCEPTION 'DECISION_PAGE_ITEM_CROSS_PROJECT: work item % lives in project %, not % — a publication belongs to its work item''s project',
      NEW."work_item_id", item_project, NEW."project_id"
      USING ERRCODE = '23514';
  END IF;

  SELECT v."page_id" INTO version_page
    FROM "page_version" v
   WHERE v."id" = NEW."page_version_id";

  IF version_page IS NOT NULL AND version_page <> NEW."page_id" THEN
    RAISE EXCEPTION 'DECISION_PAGE_VERSION_CROSS_PAGE: version % belongs to page %, not % — a publication names a version of its own page',
      NEW."page_version_id", version_page, NEW."page_id"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_decision_page_publication_cotenancy
  BEFORE INSERT OR UPDATE OF "workspace_id", "project_id", "work_item_id", "page_id", "page_version_id" ON "decision_page_publication"
  FOR EACH ROW EXECUTE FUNCTION enforce_decision_page_publication_cotenancy();

-- 4. RLS on decision_page_publication ----------------------------------------------------
--
-- The `page` pair: PERMISSIVE FOR ALL on the row's own `workspace_id`, and
-- RESTRICTIVE FOR SELECT narrowing to `app.project_id` when it is set.
ALTER TABLE "decision_page_publication" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "decision_page_publication" FORCE ROW LEVEL SECURITY;

CREATE POLICY "decision_page_publication_active_workspace" ON "decision_page_publication"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

CREATE POLICY "decision_page_publication_project_narrow" ON "decision_page_publication"
  AS RESTRICTIVE
  FOR SELECT
  USING (
    coalesce(current_setting('app.project_id', true), '') = ''
    OR "project_id" = current_setting('app.project_id', true)
  );
