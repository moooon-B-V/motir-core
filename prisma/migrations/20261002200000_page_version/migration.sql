-- PAGE VERSIONS — a page's history (Epic MOTIR-5746 · Story MOTIR-5754 · MOTIR-7382).
--
-- `docs/decisions/pages.md` §6: a version is a SNAPSHOT of the page body by one
-- author. `@motir/pages` decides when a save extends the latest version or
-- starts a new one, and when the oldest is pruned; this table only keeps them.
-- It follows `20261001230000_page` clause for clause: the same FK actions, a
-- SECURITY DEFINER tenancy backstop, the same RLS pair.
--
-- WHAT THIS MIGRATION DOES
--   1. `page_version` — the table, its unique (page, number) and its FKs (every
--      one a Prisma `@relation`, both sides, same actions).
--   2. The CHECKs: `number >= 1`, `saved_at >= started_at`, and a restore row
--      always carries its source's number.
--   3. The cotenancy trigger: a version shares its page's workspace and project,
--      and a restore names a version OF THE SAME PAGE.
--   4. RLS — the `page` pair.
--   5. The BACKFILL: every existing page gets version 1, its current body.
--
-- One deploy, no expand/contract: the table is additive, nothing reads it
-- before the adapter that ships in the same pull request, and the backfill runs
-- here.

-- 1. The table ------------------------------------------------------------------
--
-- `restored_from_number` is the source's number, kept when the source is
-- pruned: `restored_from_version_id` is SET NULL by the prune, and without the
-- number the row would forget it was a restore at all. A number with a NULL id
-- reads "restored from vN, no longer kept".
CREATE TABLE "page_version" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "page_id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "author_id" TEXT NOT NULL,
    "body_state" BYTEA NOT NULL,
    "body_markdown" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "saved_at" TIMESTAMP(3) NOT NULL,
    "restored_from_version_id" TEXT,
    "restored_from_number" INTEGER,

    CONSTRAINT "page_version_pkey" PRIMARY KEY ("id")
);

-- Numbers are per page and never reused. The same btree serves the newest-first
-- list and `latestVersion` by a backward scan, so no separate DESC index.
CREATE UNIQUE INDEX "page_version_page_id_number_key" ON "page_version"("page_id", "number");

-- As every tenant table carries.
CREATE INDEX "page_version_workspace_id_idx" ON "page_version"("workspace_id");

-- ON DELETE, one FK at a time:
--   * workspace_id / project_id  CASCADE — the `page` choice.
--   * page_id  CASCADE — a permanent page delete takes its history (§7).
--   * author_id  RESTRICT — durable attribution, as `page.updated_by_id`.
--   * restored_from_version_id  SET NULL — pruning a restore's source keeps the
--     restore row; `restored_from_number` keeps what it was restored from.
ALTER TABLE "page_version" ADD CONSTRAINT "page_version_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "page_version" ADD CONSTRAINT "page_version_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "page_version" ADD CONSTRAINT "page_version_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "page_version" ADD CONSTRAINT "page_version_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "page_version" ADD CONSTRAINT "page_version_restored_from_version_id_fkey" FOREIGN KEY ("restored_from_version_id") REFERENCES "page_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 2. The CHECKs -------------------------------------------------------------------
ALTER TABLE "page_version" ADD CONSTRAINT "page_version_number_positive" CHECK ("number" >= 1);

ALTER TABLE "page_version" ADD CONSTRAINT "page_version_saved_after_started" CHECK ("saved_at" >= "started_at");

ALTER TABLE "page_version" ADD CONSTRAINT "page_version_restore_keeps_number" CHECK ("restored_from_version_id" IS NULL OR "restored_from_number" IS NOT NULL);

-- 3. The cotenancy trigger ----------------------------------------------------------
--
-- SECURITY DEFINER with `search_path` pinned, for the reason the page migration
-- gives: the row a tenancy check reads may lie OUTSIDE the invoking RLS context,
-- so as SECURITY INVOKER the lookup reads NULL for exactly the write it exists
-- to refuse. The body reads by primary key and returns nothing; the only
-- observable outputs are the RAISEs.
CREATE OR REPLACE FUNCTION enforce_page_version_cotenancy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  page_workspace text;
  page_project   text;
  source_page    text;
BEGIN
  SELECT p."workspace_id", p."project_id"
    INTO page_workspace, page_project
    FROM "page" p
   WHERE p."id" = NEW."page_id";

  -- Missing: defer to the foreign key, which gives the clearer error.
  IF page_workspace IS NOT NULL THEN
    IF page_workspace <> NEW."workspace_id" THEN
      RAISE EXCEPTION 'PAGE_VERSION_CROSS_WORKSPACE: page % lives in workspace %, not % — a version belongs to its page''s workspace',
        NEW."page_id", page_workspace, NEW."workspace_id"
        USING ERRCODE = '23514';
    END IF;
    IF page_project <> NEW."project_id" THEN
      RAISE EXCEPTION 'PAGE_VERSION_CROSS_PROJECT: page % lives in project %, not % — a version belongs to its page''s project',
        NEW."page_id", page_project, NEW."project_id"
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."restored_from_version_id" IS NOT NULL THEN
    SELECT v."page_id" INTO source_page
      FROM "page_version" v
     WHERE v."id" = NEW."restored_from_version_id";

    IF source_page IS NOT NULL AND source_page <> NEW."page_id" THEN
      RAISE EXCEPTION 'PAGE_VERSION_RESTORE_CROSS_PAGE: version % belongs to page %, not % — a page restores only its own versions',
        NEW."restored_from_version_id", source_page, NEW."page_id"
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_page_version_cotenancy
  BEFORE INSERT OR UPDATE OF "page_id", "workspace_id", "project_id", "restored_from_version_id" ON "page_version"
  FOR EACH ROW EXECUTE FUNCTION enforce_page_version_cotenancy();

-- 4. RLS on page_version ---------------------------------------------------------
--
-- The `page` pair: PERMISSIVE FOR ALL on the row's own `workspace_id` (USING +
-- WITH CHECK), and RESTRICTIVE FOR SELECT narrowing to `app.project_id` when it
-- is set. The workspace RLS migration's `ALTER DEFAULT PRIVILEGES` grants the
-- app role on every new table.
ALTER TABLE "page_version" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "page_version" FORCE ROW LEVEL SECURITY;

CREATE POLICY "page_version_active_workspace" ON "page_version"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

CREATE POLICY "page_version_project_narrow" ON "page_version"
  AS RESTRICTIVE
  FOR SELECT
  USING (
    coalesce(current_setting('app.project_id', true), '') = ''
    OR "project_id" = current_setting('app.project_id', true)
  );

-- 5. The backfill -------------------------------------------------------------------
--
-- Every page that existed before this story gets ONE version: its current body,
-- by its last writer, spanning its life so far. Without it a pre-existing page
-- would show an empty history, which reads as "nobody ever wrote this".
--
-- Migrations run as the BYPASSRLS owner (`20260527134009_add_workspace_rls`),
-- so this `INSERT … SELECT` sees every tenant's pages despite FORCE.
INSERT INTO "page_version" (
  "id", "workspace_id", "project_id", "page_id", "number", "author_id",
  "body_state", "body_markdown", "started_at", "saved_at"
)
SELECT
  gen_random_uuid()::text,
  p."workspace_id",
  p."project_id",
  p."id",
  1,
  p."updated_by_id",
  p."body_state",
  p."body_markdown",
  p."created_at",
  greatest(p."updated_at", p."created_at")
FROM "page" p;
