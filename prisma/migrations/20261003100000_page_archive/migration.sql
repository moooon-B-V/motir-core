-- PAGE ARCHIVE COLUMNS (Epic MOTIR-5746 · Story MOTIR-5755 · MOTIR-7417).
--
-- The storage `docs/decisions/pages.md` §7 names: a page records THAT it is
-- archived (`archived_at`), WHICH archive operation took it (`archive_root_id`,
-- the id of the page the member archived — every sub-page that left with it
-- carries the same value), and WHO archived it (`archived_by_id`), so the
-- Archived pages list can name the actor without a revision table.
--
-- EXPAND-ONLY. Three nullable columns with no DEFAULT and nothing reading them
-- yet, so this deploys safely before every reader, and there is no backfill:
-- every existing page is live, which is both columns null.
--
-- NO "ORIGINAL POSITION" COLUMN. An archived page keeps its own
-- `parent_page_id`, `folder_id`, `position` and `ancestor_page_ids` untouched.
-- Those ARE its original place, which is what makes "restore to where it was"
-- possible without a copy.
--
-- The existing triggers are untouched: `trg_page_cotenancy` fires on
-- `parent_page_id` / `folder_id` / `workspace_id` / `project_id` and
-- `trg_page_cycle` on `parent_page_id`; neither column list gains anything. The
-- RLS pair `page_active_workspace` / `page_project_narrow` is row-level and so
-- already covers the new columns.

-- 1. The columns ---------------------------------------------------------------
--
-- `archive_root_id` is DELIBERATELY NOT A FOREIGN KEY. It names a page in the
-- same archive set (the root itself) — an ancestor of every other member. A
-- self-FK would need `ON DELETE SET NULL` to let a set be deleted, and that
-- would break the pairing CHECK below the moment a root went; the service
-- deletes a whole set in one statement anyway. This is the same choice as
-- `ancestor_page_ids`, which is also an unenforced id array.
--
-- `archived_by_id` is a real FK (modelled as `Page.archivedBy` ↔
-- `User.archivedPages`, the FK-`@relation` rule), SET NULL: deleting the user
-- forgets who archived the page and leaves it archived.
ALTER TABLE "page"
  ADD COLUMN "archived_at" TIMESTAMPTZ(3),
  ADD COLUMN "archive_root_id" TEXT,
  ADD COLUMN "archived_by_id" TEXT;

ALTER TABLE "page" ADD CONSTRAINT "page_archived_by_id_fkey" FOREIGN KEY ("archived_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 2. The pairing CHECK -----------------------------------------------------------
--
-- A page is either LIVE (both null) or ARCHIVED (both set) — never half. The
-- actor is outside the pairing because its SET NULL may clear it on an archived
-- page. Prisma does not model CHECK constraints and its differ does not propose
-- dropping one.
ALTER TABLE "page" ADD CONSTRAINT "page_archive_pairing" CHECK (("archived_at" IS NULL) = ("archive_root_id" IS NULL));

-- 3. The indexes ------------------------------------------------------------------
--
-- Both PARTIAL, hand-written, and so deliberately absent from `schema.prisma`
-- (Prisma cannot express a `WHERE`). Neither reuses the column list of any
-- `@@index` on `Page`, so the differ has nothing to pair them with and ignores
-- them — the MOTIR-1960 rule.
--
-- The Archived pages list's keyset read: the ROOTS of each archive in a
-- project, newest first.
CREATE INDEX "page_archived_roots_idx" ON "page"("project_id", "archived_at" DESC, "id" DESC) WHERE "archive_root_id" = "id";

-- Reading one archive set (restore and delete take the whole set).
CREATE INDEX "page_archive_root_idx" ON "page"("archive_root_id") WHERE "archive_root_id" IS NOT NULL;
