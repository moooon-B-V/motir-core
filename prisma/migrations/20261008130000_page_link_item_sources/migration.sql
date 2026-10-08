-- PAGE TAGS IN A WORK ITEM'S OWN TEXT — two more DERIVED link sources
-- (Story MOTIR-7694 · MOTIR-7696, `docs/decisions/pages.md` §8.1).
--
-- `mention` and `embed` rows are derived from a PAGE body and keyed on the page.
-- `description` and `explanation` rows are the reverse direction: derived from a
-- WORK ITEM's Description / Explanation (`[<title>](motir-page:<pageId>)`
-- tokens) on every work-item create and update, keyed on the work item. A page
-- save never touches them, and a work-item save never touches a page-derived or
-- a `manual` row.
--
-- WHAT THIS MIGRATION DOES
--   Adds the two values to `page_work_item_link_source`. Nothing else: the
--   unique key `(page_id, work_item_id, source)`, the same-project trigger and
--   the RLS pair already cover them.
--
-- ⚠️ ITS OWN FILE: Postgres refuses to USE an enum value in the transaction that
-- added it, so nothing may write a `description` / `explanation` row here.
--
-- EXPAND-ONLY: no work-item body holds a `motir-page:` token before the code
-- that ships beside it, so there is nothing to back-fill.

ALTER TYPE "page_work_item_link_source" ADD VALUE 'description';
ALTER TYPE "page_work_item_link_source" ADD VALUE 'explanation';
