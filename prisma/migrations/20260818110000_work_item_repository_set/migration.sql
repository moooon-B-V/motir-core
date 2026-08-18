-- MOTIR-2727 (Story MOTIR-2725, ADR `docs/decisions/work-item-repository-set.md` §1):
-- a work item's repositories become a SET.
--
-- `targetRepo` could only ever name ONE repository, and the completion gate in
-- `lib/services/changeRequestStatusSync.ts` therefore had no EXPECTED side to
-- check a merge against — `countOtherOpenByWorkItem` counts pull requests that
-- EXIST, so a repository whose PR had not been opened yet contributed nothing
-- and the item completed on half its work (MOTIR-2664). `target_repos` is that
-- expected side: every repository the item ships in, ordered, element 0 the
-- PRIMARY that `targetRepo` mirrors and that dispatch resolves.
--
-- A COLUMN and not a join table (ADR §1.1): the pin has no foreign key, no index
-- and is never a query key, so a join table would buy referential integrity
-- against a domain that is deliberately not referentially bound — a pin must
-- survive its repository being briefly disconnected — at the cost of a new
-- workspace-scoped table, its own RLS policies, and a join on the hottest read
-- in the product. A scalar array is covered by `work_item`'s existing policies
-- with NO policy change at all, which is what this migration's silence about RLS
-- means: it adds no table and no predicate, so the shipped `work_item` policies
-- (workspace-bound, unchanged since the table was created) cover the new column
-- exactly as they cover `targetRepo` beside it.
--
-- `targetRepoRole` is deliberately NOT widened (ADR §1.3) — two parallel Prisma
-- scalar lists cannot represent an element whose name is known and whose role is
-- not, and nothing can author a multi-element role list until MOTIR-2732.
-- Deferred as MOTIR-2978. This migration does not read or write that column.
--
-- BACKFILL, in the same migration: every existing non-null pin becomes the
-- one-element set `[pin]`; every null pin becomes the empty set. An empty set and
-- a null pin are ONE state — "this card does not say where it ships" — which is
-- the common case and must keep behaving exactly as it does today. No card's
-- resolved dispatch repository changes: `resolveDispatchRepo` reads element 0,
-- which for every row that exists at this moment is the value it read before.

-- AlterTable
ALTER TABLE "work_item" ADD COLUMN     "targetRepos" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Backfill the one-element set from the shipped scalar pin. Rows with a NULL pin
-- keep the column default (the empty array), so they are not touched.
UPDATE "work_item"
SET "targetRepos" = ARRAY["targetRepo"]
WHERE "targetRepo" IS NOT NULL;
