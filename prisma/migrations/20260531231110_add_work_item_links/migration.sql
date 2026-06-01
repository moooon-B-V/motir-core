-- CreateEnum
CREATE TYPE "work_item_link_kind" AS ENUM ('is_blocked_by', 'relates_to', 'duplicates', 'clones');

-- CreateTable
CREATE TABLE "work_item_link" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "kind" "work_item_link_kind" NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_item_link_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "work_item_link_toId_kind_idx" ON "work_item_link"("toId", "kind");

-- CreateIndex
CREATE INDEX "work_item_link_fromId_kind_idx" ON "work_item_link"("fromId", "kind");

-- CreateIndex
CREATE INDEX "work_item_link_workspaceId_idx" ON "work_item_link"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "work_item_link_fromId_toId_kind_key" ON "work_item_link"("fromId", "toId", "kind");

-- AddForeignKey
ALTER TABLE "work_item_link" ADD CONSTRAINT "work_item_link_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_link" ADD CONSTRAINT "work_item_link_toId_fkey" FOREIGN KEY ("toId") REFERENCES "work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_link" ADD CONSTRAINT "work_item_link_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_link" ADD CONSTRAINT "work_item_link_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- Structural-integrity triggers (appended from prisma/sql/work_item_link_triggers.sql)
-- See that file for the full rationale. Kept in sync by hand; the
-- standalone file is the readable reference, this copy is what runs.
-- ============================================================

-- Work-item-link structural-integrity triggers (Story 1.4 · Subtask 1.4.3)
-- =========================================================================
-- These three BEFORE triggers are the DB-layer source of truth for the
-- work_item_link table's structural rules. The service layer (1.4.4) also
-- checks these before issuing the write for a friendlier error, but the
-- database is the backstop: a direct SQL write, a buggy service path, or a
-- future code path that forgets the check still cannot produce a corrupt
-- link graph.
--
-- Each rejection RAISEs SQLSTATE 23514 (check_violation) with a leading
-- message MARKER (WI_LINK_CYCLE / WI_LINK_CROSS_WORKSPACE /
-- WI_LINK_WORKSPACE_MISMATCH / WI_LINK_SELF). workItemLinkRepository's
-- create method matches on 23514 + the marker and translates to the typed
-- errors in lib/workItems/linkErrors.ts, so the service layer never inspects
-- raw Postgres error codes (the 4-layer rule).
--
-- Column identifiers are camelCase (Prisma's default column naming — there
-- is no @map on the columns), so every reference is double-quoted; an
-- unquoted NEW.fromId would fold to NEW.fromid and silently miss.
--
-- Trigger FIRING ORDER (Postgres fires per-statement BEFORE-row triggers in
-- alphabetical order by trigger name). The trigger names are deliberately
-- chosen so they sort: cycle → self → workspace. This ordering surfaces the
-- most semantically interesting error first when multiple rules are
-- violated by the same write:
--   * A self-link (fromId = toId) of kind is_blocked_by is BOTH a cycle (a
--     row is its own blocker) and a self-link. The cycle CTE explicitly
--     stops at one hop on a self row to avoid an infinite walk, so cycle
--     does NOT fire for the self case; self fires instead. We achieve this
--     by having the cycle CTE walk only outgoing `is_blocked_by` edges from
--     toId, which never visits NEW.fromId for the self case (toId = fromId
--     and the recursive step requires a different row).
--   * A cross-workspace self-link is rejected by `self` (the cheapest check)
--     before the `workspace` trigger walks the two FKs.
--
-- NOTE for Subtask 1.4.5 (RLS): these functions SELECT sibling rows from
-- work_item / work_item_link by id. When FORCE ROW LEVEL SECURITY lands on
-- work_item_link, the trigger's internal lookups will be subject to the
-- same workspace GUC policy as the invoking statement. Within a single
-- workspace every link's referenced items share one workspaceId, so the
-- active app.workspace_id GUC will match — but 1.4.5 must verify this and,
-- if needed, mark these functions SECURITY DEFINER. Logged as a forward
-- note in PRODECT_FINDINGS.md (mirrors the equivalent note in
-- work_item_triggers.sql).

-- 1. Cycle prevention (is_blocked_by only) -----------------------------------
--    `is_blocked_by` defines a directed dependency graph (A is_blocked_by B
--    means A waits on B). A cycle in this graph is unbreakable scheduling
--    deadlock for the AI planner's ready-set engine, so it's a DB-level
--    invariant, not a UI-only check. The other three kinds (`relates_to`,
--    `duplicates`, `clones`) are intentionally allowed to be reciprocal /
--    cyclic — `relates_to` IS expected to be symmetric (the service may
--    persist B→A alongside A→B), `duplicates` and `clones` are descriptive
--    annotations, not scheduling constraints.
--
--    Walks DOWN the blocker chain starting from NEW."toId" (the thing the
--    new row says NEW.fromId depends on); if the walk ever reaches
--    NEW."fromId", inserting this row would close the loop and is rejected.
--    The walk follows `is_blocked_by` edges only — other kinds don't
--    participate in scheduling and shouldn't block a perfectly legal
--    `is_blocked_by` link.
--
--    Self-link (fromId = toId) is rejected by trigger (c) below, not here.
--    The CTE's recursive step joins on existing links (kind = is_blocked_by)
--    only and does not include NEW itself, so it cannot loop on the self
--    row even if one existed.
CREATE OR REPLACE FUNCTION enforce_work_item_link_no_cycle()
RETURNS TRIGGER AS $$
DECLARE
  creates_cycle boolean;
BEGIN
  IF NEW."kind" <> 'is_blocked_by' THEN
    RETURN NEW;
  END IF;

  -- Defer the self-link case to trg_work_item_link_self for a clearer error.
  IF NEW."fromId" = NEW."toId" THEN
    RETURN NEW;
  END IF;

  WITH RECURSIVE chain AS (
    SELECT l."fromId", l."toId", 1 AS lvl
      FROM "work_item_link" l
      WHERE l."fromId" = NEW."toId"
        AND l."kind" = 'is_blocked_by'
    UNION ALL
    SELECT l."fromId", l."toId", c.lvl + 1
      FROM "work_item_link" l
      JOIN chain c ON l."fromId" = c."toId"
      WHERE l."kind" = 'is_blocked_by'
        AND c.lvl < 1000
  )
  SELECT EXISTS (SELECT 1 FROM chain WHERE "toId" = NEW."fromId") INTO creates_cycle;

  IF creates_cycle THEN
    RAISE EXCEPTION 'WI_LINK_CYCLE: linking % is_blocked_by % would create a dependency cycle', NEW."fromId", NEW."toId"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2. Self-link rejection -----------------------------------------------------
--    fromId = toId is never meaningful for any kind. A "self-blocker" is a
--    cycle of length 1; a "self-relates" / "self-duplicates" / "self-clones"
--    is a UI bug. Reject at the DB layer so the data never carries one.
CREATE OR REPLACE FUNCTION enforce_work_item_link_no_self()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."fromId" = NEW."toId" THEN
    RAISE EXCEPTION 'WI_LINK_SELF: a work item cannot link to itself (fromId = toId = %)', NEW."fromId"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. Workspace consistency ---------------------------------------------------
--    Two checks live here:
--      (a) fromItem.workspaceId = toItem.workspaceId — no cross-workspace
--          links. (Cross-PROJECT links inside the SAME workspace ARE allowed;
--          real teams have epics whose stories live in sibling projects.)
--      (b) NEW.workspaceId = fromItem.workspaceId — the denormalized column
--          on the link row must match the truth on fromItem. A mismatch here
--          is a service-layer bug — the row would slip through workspace-
--          scoped RLS reads as if it belonged to the wrong tenant.
--
--    Missing referenced rows are deferred to the FK constraint (a NULL
--    workspaceId from the lookup short-circuits to RETURN NEW so the FK
--    fires with a clearer message). Both checks are O(2 index lookups) on
--    work_item.id (the PK), cheap on the hot path.
CREATE OR REPLACE FUNCTION enforce_work_item_link_workspace()
RETURNS TRIGGER AS $$
DECLARE
  from_workspace text;
  to_workspace   text;
BEGIN
  SELECT w."workspaceId" INTO from_workspace FROM "work_item" w WHERE w."id" = NEW."fromId";
  SELECT w."workspaceId" INTO to_workspace   FROM "work_item" w WHERE w."id" = NEW."toId";

  -- Defer missing-row cases to the FK constraint.
  IF from_workspace IS NULL OR to_workspace IS NULL THEN
    RETURN NEW;
  END IF;

  IF from_workspace <> to_workspace THEN
    RAISE EXCEPTION 'WI_LINK_CROSS_WORKSPACE: fromItem workspace % does not match toItem workspace %', from_workspace, to_workspace
      USING ERRCODE = '23514';
  END IF;

  IF NEW."workspaceId" <> from_workspace THEN
    RAISE EXCEPTION 'WI_LINK_WORKSPACE_MISMATCH: link.workspaceId % does not match fromItem.workspaceId %', NEW."workspaceId", from_workspace
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers -------------------------------------------------------------------
-- Names sort cycle → self → workspace (see FIRING ORDER note above). All
-- three fire on INSERT and on UPDATE of the relevant columns. The columns we
-- listen for on UPDATE are the ones whose change could violate the rule:
-- cycle + self watch fromId/toId/kind; workspace watches fromId/toId/
-- workspaceId.
CREATE TRIGGER trg_work_item_link_cycle
  BEFORE INSERT OR UPDATE OF "fromId", "toId", "kind" ON "work_item_link"
  FOR EACH ROW EXECUTE FUNCTION enforce_work_item_link_no_cycle();

CREATE TRIGGER trg_work_item_link_self
  BEFORE INSERT OR UPDATE OF "fromId", "toId" ON "work_item_link"
  FOR EACH ROW EXECUTE FUNCTION enforce_work_item_link_no_self();

CREATE TRIGGER trg_work_item_link_workspace
  BEFORE INSERT OR UPDATE OF "fromId", "toId", "workspaceId" ON "work_item_link"
  FOR EACH ROW EXECUTE FUNCTION enforce_work_item_link_workspace();
