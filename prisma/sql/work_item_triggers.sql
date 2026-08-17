-- Work-item structural-integrity triggers (Story 1.4 · Subtask 1.4.2)
-- ====================================================================
-- These three BEFORE triggers are the DB-layer source of truth for the
-- work_item tree's structural rules. The service layer (1.4.4) also checks
-- these before issuing the write for a friendlier error, but the database is
-- the backstop: a direct SQL write, a buggy service path, or a future code
-- path that forgets the check still cannot corrupt the tree.
--
-- Each rejection RAISEs SQLSTATE 23514 (check_violation) with a leading
-- message MARKER (WI_ILLEGAL_PARENT_TYPE / WI_SUBTASK_NEEDS_PARENT /
-- WI_DEPTH_LIMIT_EXCEEDED / WI_PARENT_CYCLE). workItemRepository's create /
-- update methods match on 23514 + the marker and translate to the typed
-- errors in lib/workItems/errors.ts, so the service layer never inspects
-- raw Postgres error codes (the 4-layer rule).
--
-- Column identifiers are camelCase (Prisma's default column naming — there
-- is no @map on the columns), so every reference is double-quoted; an
-- unquoted NEW.parentId would fold to NEW.parentid and silently miss.
--
-- Trigger FIRING ORDER (Postgres fires per-statement BEFORE-row triggers in
-- alphabetical order by trigger name). The trigger names are deliberately
-- chosen so they sort: cycle → depth → kind. This ordering is load-bearing
-- because a single illegal write often violates more than one axis, and the
-- FIRST trigger to RAISE wins:
--   * A cyclic re-parent (moving an ancestor under its own descendant) is
--     ALSO kind-illegal — the ancestor is a "bigger" kind than the
--     descendant, so the kind matrix would reject it too. We want the more
--     fundamental "this creates a cycle" error, so cycle fires before kind.
--     (A non-cyclic but kind-illegal re-parent still surfaces the kind error,
--     because the cycle trigger passes cleanly when there's no cycle.)
--   * Inserting any child under a depth-4 subtask is BOTH a depth violation
--     (5 levels) AND a kind violation (nothing may parent to a subtask).
--     depth fires before kind so the "too deep" error wins. (cycle does not
--     fire on INSERT — see below.)
-- Tests that target the kind-parent rule in isolation construct shallow,
-- acyclic fixtures so neither depth nor cycle trips first.
--
-- RLS (Subtask 1.4.5, ANSWERED — re-examined by MOTIR-2884): these functions
-- SELECT sibling rows from work_item by id, and under FORCE ROW LEVEL SECURITY
-- a SECURITY INVOKER function's internal lookups run under the invoking
-- statement's policies — narrowed by BOTH app.workspace_id (the permissive
-- gate) and app.project_id (the restrictive FOR SELECT narrowing). All three
-- functions here remain SECURITY INVOKER.
--
-- Read that verdict precisely, because the note it replaces was too generous.
-- Their in-context premise — "within a single subtree every row shares one
-- workspaceId" — is TRUE, but it holds because the SERVICE enforces
-- same-project parenting (`CrossProjectParentError` in workItemsService), and
-- nothing in the database compares parent.workspaceId / parent.projectId with
-- the child's. So a chain that left the bound context would TRUNCATE these
-- walks silently (an under-counted depth, an undetected cycle, an unapplied
-- kind matrix) — the DB backstop's completeness rests on the application check
-- it exists to backstop. Marking these SECURITY DEFINER does NOT fix that: it
-- would restore the three checks while still admitting the cross-tenant
-- parentId, which is the actual gap and is equally open under the owner role.
-- The fix is a DB-level parent-tenancy check, carded separately.
--
-- The full six-function verdict lives in migration
-- 20260817120000_link_workspace_trigger_security_definer, which marks the ONE
-- function whose subject IS a row in another tenant
-- (`enforce_work_item_link_workspace`, work_item_link_triggers.sql) SECURITY
-- DEFINER. Read it before changing any trigger's security label.

-- 1. Kind-parent matrix ------------------------------------------------------
--    epic.parentId    IS NULL                       (epics are always roots)
--    story.parentId   ∈ {epic, NULL}                (top-level stories allowed)
--    task.parentId    ∈ {epic, story, NULL}
--    bug.parentId     ∈ {epic, story, task, NULL}
--    subtask.parentId ∈ {story, task, bug}          (subtask MUST have a parent)
CREATE OR REPLACE FUNCTION enforce_work_item_kind_parent()
RETURNS TRIGGER AS $$
DECLARE
  item_kind   text := NEW."kind"::text;
  parent_kind text;
BEGIN
  IF NEW."parentId" IS NULL THEN
    -- A subtask is the only kind that may not be a root.
    IF item_kind = 'subtask' THEN
      RAISE EXCEPTION 'WI_SUBTASK_NEEDS_PARENT: a subtask must have a parent (story, task, or bug)'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- parentId is present from here on.
  IF item_kind = 'epic' THEN
    RAISE EXCEPTION 'WI_ILLEGAL_PARENT_TYPE: an epic must be top-level (parentId must be NULL)'
      USING ERRCODE = '23514';
  END IF;

  SELECT w."kind"::text INTO parent_kind FROM "work_item" w WHERE w."id" = NEW."parentId";

  -- Parent row missing: defer to the foreign-key constraint for a clear
  -- error rather than masking it with a parent-type rejection.
  IF parent_kind IS NULL THEN
    RETURN NEW;
  END IF;

  IF item_kind = 'story' AND parent_kind NOT IN ('epic') THEN
    RAISE EXCEPTION 'WI_ILLEGAL_PARENT_TYPE: a story may only be parented to an epic (got %)', parent_kind
      USING ERRCODE = '23514';
  ELSIF item_kind = 'task' AND parent_kind NOT IN ('epic', 'story') THEN
    RAISE EXCEPTION 'WI_ILLEGAL_PARENT_TYPE: a task may only be parented to an epic or story (got %)', parent_kind
      USING ERRCODE = '23514';
  ELSIF item_kind = 'bug' AND parent_kind NOT IN ('epic', 'story', 'task') THEN
    RAISE EXCEPTION 'WI_ILLEGAL_PARENT_TYPE: a bug may only be parented to an epic, story, or task (got %)', parent_kind
      USING ERRCODE = '23514';
  ELSIF item_kind = 'subtask' AND parent_kind NOT IN ('story', 'task', 'bug') THEN
    RAISE EXCEPTION 'WI_ILLEGAL_PARENT_TYPE: a subtask may only be parented to a story, task, or bug (got %)', parent_kind
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2. Depth limit -------------------------------------------------------------
--    Walks UP the parent chain (rooted at the nearest ancestor whose parentId
--    IS NULL) via a recursive CTE and rejects when the row's resulting depth
--    would exceed 4 levels. The deepest legal chain is 4: epic → story → task
--    → subtask (or epic → story → bug → subtask). The walk is bounded by the
--    legal depth, with a hard lvl guard as a belt-and-suspenders cycle stop
--    (the no-cycle trigger keeps the existing tree acyclic, so the guard is
--    never actually hit in practice).
CREATE OR REPLACE FUNCTION enforce_work_item_depth_limit()
RETURNS TRIGGER AS $$
DECLARE
  ancestor_depth int;
BEGIN
  -- A root (no parent) is depth 1 — always within the limit.
  IF NEW."parentId" IS NULL THEN
    RETURN NEW;
  END IF;

  WITH RECURSIVE chain AS (
    SELECT w."id", w."parentId", 1 AS lvl
      FROM "work_item" w
      WHERE w."id" = NEW."parentId"
    UNION ALL
    SELECT w."id", w."parentId", c.lvl + 1
      FROM "work_item" w
      JOIN chain c ON w."id" = c."parentId"
      WHERE c.lvl < 100
  )
  SELECT max(lvl) INTO ancestor_depth FROM chain;

  -- Parent missing: defer to the FK constraint.
  IF ancestor_depth IS NULL THEN
    RETURN NEW;
  END IF;

  IF ancestor_depth + 1 > 4 THEN
    RAISE EXCEPTION 'WI_DEPTH_LIMIT_EXCEEDED: work item depth % exceeds the limit of 4', ancestor_depth + 1
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. Cycle prevention --------------------------------------------------------
--    On UPDATE of parentId, walks UP from the new parentId; if the chain
--    reaches the row being updated, the re-parent would create a cycle and is
--    rejected. Also rejects a direct self-parent (parentId = id).
CREATE OR REPLACE FUNCTION enforce_work_item_no_cycle()
RETURNS TRIGGER AS $$
DECLARE
  creates_cycle boolean;
BEGIN
  IF NEW."parentId" IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW."parentId" = NEW."id" THEN
    RAISE EXCEPTION 'WI_PARENT_CYCLE: a work item cannot be its own parent'
      USING ERRCODE = '23514';
  END IF;

  WITH RECURSIVE chain AS (
    SELECT w."id", w."parentId", 1 AS lvl
      FROM "work_item" w
      WHERE w."id" = NEW."parentId"
    UNION ALL
    SELECT w."id", w."parentId", c.lvl + 1
      FROM "work_item" w
      JOIN chain c ON w."id" = c."parentId"
      WHERE c.lvl < 1000
  )
  SELECT EXISTS (SELECT 1 FROM chain WHERE "id" = NEW."id") INTO creates_cycle;

  IF creates_cycle THEN
    RAISE EXCEPTION 'WI_PARENT_CYCLE: re-parenting % under % would create a cycle', NEW."id", NEW."parentId"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers -------------------------------------------------------------------
-- Names sort cycle → depth → kind (see FIRING ORDER note above). kind + depth
-- fire on INSERT and on UPDATE of parentId/kind; cycle only matters on a
-- re-parent (a fresh INSERT cannot point at a row that points back at it), so
-- it fires on UPDATE of parentId only.
CREATE TRIGGER trg_work_item_cycle
  BEFORE UPDATE OF "parentId" ON "work_item"
  FOR EACH ROW EXECUTE FUNCTION enforce_work_item_no_cycle();

CREATE TRIGGER trg_work_item_depth
  BEFORE INSERT OR UPDATE OF "parentId", "kind" ON "work_item"
  FOR EACH ROW EXECUTE FUNCTION enforce_work_item_depth_limit();

CREATE TRIGGER trg_work_item_kind
  BEFORE INSERT OR UPDATE OF "parentId", "kind" ON "work_item"
  FOR EACH ROW EXECUTE FUNCTION enforce_work_item_kind_parent();
