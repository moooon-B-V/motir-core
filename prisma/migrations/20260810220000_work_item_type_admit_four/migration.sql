-- Admit four members to `work_item_type` (Story MOTIR-2622 · Subtask MOTIR-2632).
--
-- The explicit enum addition the 2.7.2 ADR reserved as the ONLY legal way to
-- grow this set; the decision is its Amendment 1 (MOTIR-2629), which admitted
-- `copy` / `translate` / `legal` / `verification` and declared `doc` an alias of
-- `content` and `spike` an alias of `research` (so neither is added here).
--
-- Purely ADDITIVE and REVERSIBLE-BY-CONSTRUCTION at the data level: no column
-- changes, no backfill, and no existing row's value moves. Every `work_item`
-- keeps the type it has — including the `content` rows that describe work which
-- would be filed `copy` today, which MOTIR-2622's scope boundary explicitly
-- leaves alone.
--
-- WHY `BEFORE`/`AFTER` AND NOT A BARE APPEND. A PostgreSQL enum carries a sort
-- order (`pg_enum.enumsortorder`), and a bare `ADD VALUE` appends to the end. The
-- Prisma schema declares these four INTERLEAVED — beside the neighbour Amendment
-- 1 §1b names — so appending would leave the database's order and the datamodel's
-- order permanently disagreeing, which `prisma migrate diff` reports as drift and
-- the `build` job fails on (the same class as the FK and partial-index drift the
-- repository CLAUDE.md documents). Anchoring each insertion keeps the two
-- identical, and keeps `ORDER BY type` in any future query matching the canonical
-- order the pickers and legends iterate.

-- AlterEnum
ALTER TYPE "work_item_type" ADD VALUE 'copy' AFTER 'content';
ALTER TYPE "work_item_type" ADD VALUE 'translate' AFTER 'copy';
ALTER TYPE "work_item_type" ADD VALUE 'verification' AFTER 'review';
ALTER TYPE "work_item_type" ADD VALUE 'legal' AFTER 'manual';
