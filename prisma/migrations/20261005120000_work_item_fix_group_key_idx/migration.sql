-- MOTIR-7589 — To fix keyed by RUN (`design/workbench/design-notes.md` § 34.2).
--
-- A stuck card's ENTRY is `fixDetail.groupKey` (`run:<id>` · `prs:<hash>` ·
-- `card:<id>`), written by `recomputeWorkItemFixReason` with the reason. The
-- Workbench reads an entry's MEMBERS by that key — the cards a dead run carried, or
-- every card one pull-request set delivers, whoever holds them — so the lookup is
-- indexed on the expression it filters by.
--
-- ⚠️ HAND-WRITTEN, and invisible to the datamodel on purpose: Prisma cannot declare an
-- expression or a partial index, and its differ ignores one it cannot express as long
-- as no `@@index` claims the same column list (CLAUDE.md, *Migrations*). This one's
-- column list is an EXPRESSION, which no `@@index` can claim. Partial on
-- `"fixReason" IS NOT NULL`: the key is null-free only on stuck rows, and those are a
-- handful of the table.
CREATE INDEX "work_item_fix_group_key_idx"
  ON "work_item" ("workspaceId", (("fixDetail" ->> 'groupKey')))
  WHERE "fixReason" IS NOT NULL;
