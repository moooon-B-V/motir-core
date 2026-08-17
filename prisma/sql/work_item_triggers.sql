-- Work-item structural-integrity triggers (Story 1.4 · Subtask 1.4.2)
-- ====================================================================
-- These four BEFORE triggers (three from 1.4.2, plus the parent-TENANCY check
-- MOTIR-2895 added) are the DB-layer source of truth for the work_item tree's
-- structural rules. The service layer (1.4.4) also checks these before issuing
-- the write for a friendlier error, but the database is the backstop: a direct
-- SQL write, a buggy service path, or a future code path that forgets the check
-- still cannot corrupt the tree.
--
-- Each rejection RAISEs SQLSTATE 23514 (check_violation) with a leading
-- message MARKER (WI_PARENT_CROSS_WORKSPACE / WI_PARENT_CROSS_PROJECT /
-- WI_ILLEGAL_PARENT_TYPE / WI_SUBTASK_NEEDS_PARENT /
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
-- chosen so they sort: cotenancy → cycle → depth → kind. This ordering is
-- load-bearing because a single illegal write often violates more than one
-- axis, and the FIRST trigger to RAISE wins:
--   * A cross-tenant parent (MOTIR-2895) is the most fundamental violation of
--     the four — "that parent is not yours" outranks any statement about its
--     kind, the chain's depth, or a cycle in it — so `cotenancy` sorts first.
--     It is also what makes the other three's SECURITY DEFINER label safe: a
--     cross-tenant parentId aborts the statement before kind / depth / cycle
--     read anything, so their widened lookups only ever address rows that
--     share the writing row's workspace AND project (see the RLS note below).
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
-- RLS (Subtask 1.4.5, ANSWERED — re-examined by MOTIR-2884, AMENDED by
-- MOTIR-2895): these functions SELECT sibling rows from work_item by id, and
-- under FORCE ROW LEVEL SECURITY a SECURITY INVOKER function's internal lookups
-- run under the invoking statement's policies — narrowed by BOTH
-- app.workspace_id (the permissive gate) and app.project_id (the restrictive
-- FOR SELECT narrowing).
--
-- 1.4.5 answered "no SECURITY DEFINER needed" for all three, on the premise
-- that "within a single subtree every row shares one workspaceId". MOTIR-2884
-- corrected that premise's STANDING rather than its truth: it held only because
-- the SERVICE enforced same-project parenting (`CrossProjectParentError` in
-- workItemsService) while NOTHING in the database compared parent tenancy — so
-- the DB backstop's completeness rested on the application check it exists to
-- backstop. 2884 deliberately did not answer that with a security label, because
-- a definer lookup here would have restored the kind / depth / cycle checks
-- while still ADMITTING the cross-tenant parentId — an unguarded case made to
-- LOOK guarded.
--
-- MOTIR-2895 ships the missing check — `enforce_work_item_parent_tenancy()`
-- (section 0 below), SECURITY DEFINER, firing FIRST — and re-decides these
-- three on the evidence it creates. Verdict: **all four are SECURITY DEFINER.**
-- Parent tenancy is now a DATABASE invariant, so the ancestor chain of any
-- legal row shares its workspaceId and its projectId — but chain TENANCY is not
-- chain VISIBILITY. The workspace axis closes (RLS's own WITH CHECK pins
-- NEW."workspaceId" to app.workspace_id, and the chain shares it); the PROJECT
-- axis does not, because `work_item_project_narrow` is FOR SELECT only, so a
-- caller bound to project P may legally write a row into project Q of the same
-- workspace and an invoker walk would then truncate at the first ancestor. That
-- is not hypothetical — 39 shipped call sites bind a non-empty app.project_id.
-- Leaving these three INVOKER would have re-seated their completeness on an
-- application-layer convention (callers binding the row's own project), which
-- is the same circularity one step out.
--
-- The full verdict, per function, lives in TWO migrations, and both are part of
-- the record: 20260817120000_link_workspace_trigger_security_definer (functions
-- 1–6, and the link trigger it fixed) and
-- 20260817160000_work_item_parent_tenancy (this check, plus the amendment to
-- its verdict for 4–6). Read them before changing any trigger's security label.

-- 0. Parent TENANCY (MOTIR-2895) ---------------------------------------------
--    A parent must live in the SAME workspace AND the SAME project as the child.
--    The work_item tree is project-local, and until this check every layer that
--    said so was above the database: `workItemsService` refuses a cross-project
--    parent (`CrossProjectParentError`, on create and on both re-parent paths)
--    and nothing below it compared parent."workspaceId" / parent."projectId"
--    with the child's at all. That made the three checks below — each of which
--    RESOLVES the parent, and each of which defers when the parent reads NULL —
--    dependent on the application check they exist to backstop.
--
--    ⚠️ SECURITY DEFINER, for the reason 2884 established and this function is
--    the pure case of: **its subject IS a row that may lie outside the invoking
--    context.** A cross-tenant parentId is, by construction, invisible to the
--    writer; as SECURITY INVOKER this lookup would read NULL for exactly the
--    write it exists to refuse, take the deferral branch, and the FK would then
--    be satisfied because the row does exist (referential-integrity checks are
--    exempt from RLS). `SET search_path = public, pg_temp` pins the standard
--    definer escalation shape shut. The widened reach leaks nothing: the body
--    reads two columns by PRIMARY KEY and returns nothing to the caller — the
--    only observable outputs are the two RAISEs, which name the workspace /
--    project of a parent id the caller itself supplied.
--
--    The reach comes from the OWNER's BYPASSRLS attribute, not from ownership:
--    work_item is FORCE ROW LEVEL SECURITY, which subjects even its owner to its
--    policies. `neondb_owner` in production and the local/CI superuser both have
--    it; a NOBYPASSRLS owner would return this defect in its silent form.
CREATE OR REPLACE FUNCTION enforce_work_item_parent_tenancy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  parent_workspace text;
  parent_project   text;
BEGIN
  IF NEW."parentId" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT w."workspaceId", w."projectId"
    INTO parent_workspace, parent_project
    FROM "work_item" w
   WHERE w."id" = NEW."parentId";

  -- Parent genuinely missing: defer to the foreign-key constraint, which gives
  -- the clearer error. Because this lookup is UNFILTERED, NULL here means "no
  -- such row" and no longer also means "the row exists but you cannot see it" —
  -- that second meaning is what made every deferral branch in this file a hole.
  IF parent_workspace IS NULL THEN
    RETURN NEW;
  END IF;

  -- Workspace first: it is the coarser tenancy boundary, and a parent in another
  -- workspace is also in another project, so reporting the project would name
  -- the smaller of two violations.
  IF parent_workspace <> NEW."workspaceId" THEN
    RAISE EXCEPTION 'WI_PARENT_CROSS_WORKSPACE: parent % lives in workspace %, not % — a work item''s parent must belong to the same workspace',
      NEW."parentId", parent_workspace, NEW."workspaceId"
      USING ERRCODE = '23514';
  END IF;

  IF parent_project <> NEW."projectId" THEN
    RAISE EXCEPTION 'WI_PARENT_CROSS_PROJECT: parent % lives in project %, not % — the work-item tree is project-local',
      NEW."parentId", parent_project, NEW."projectId"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

-- 1. Kind-parent matrix ------------------------------------------------------
--    epic.parentId    IS NULL                       (epics are always roots)
--    story.parentId   ∈ {epic, NULL}                (top-level stories allowed)
--    task.parentId    ∈ {epic, story, NULL}
--    bug.parentId     ∈ {epic, story, task, NULL}
--    subtask.parentId ∈ {story, task, bug}          (subtask MUST have a parent)
--
--    SECURITY DEFINER as of MOTIR-2895 (see the RLS note in the header): the
--    parent-tenancy trigger above fires FIRST, so by the time this runs the
--    parent is known to share NEW's workspace and project — the widened lookup
--    can only ever address a row inside the writer's own tenant, and its NULL
--    now means "absent", not "hidden".
CREATE OR REPLACE FUNCTION enforce_work_item_kind_parent()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
$$;

-- 2. Depth limit -------------------------------------------------------------
--    Walks UP the parent chain (rooted at the nearest ancestor whose parentId
--    IS NULL) via a recursive CTE and rejects when the row's resulting depth
--    would exceed 4 levels. The deepest legal chain is 4: epic → story → task
--    → subtask (or epic → story → bug → subtask). The walk is bounded by the
--    legal depth, with a hard lvl guard as a belt-and-suspenders cycle stop
--    (the no-cycle trigger keeps the existing tree acyclic, so the guard is
--    never actually hit in practice).
--
--    SECURITY DEFINER as of MOTIR-2895. This walk is the one where the invoker
--    filtering did the most damage and was hardest to see: a truncated chain
--    does not error, it just returns a SMALLER max(lvl), so the check passes by
--    under-counting. Parent tenancy makes the whole chain same-project by
--    induction (each row shares its parent's project, transitively), and the
--    definer label is what makes that chain VISIBLE regardless of which project
--    the writer happens to have bound in app.project_id.
CREATE OR REPLACE FUNCTION enforce_work_item_depth_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
$$;

-- 3. Cycle prevention --------------------------------------------------------
--    On UPDATE of parentId, walks UP from the new parentId; if the chain
--    reaches the row being updated, the re-parent would create a cycle and is
--    rejected. Also rejects a direct self-parent (parentId = id).
--
--    SECURITY DEFINER as of MOTIR-2895, same argument as the depth walk: a
--    truncated chain simply fails to CONTAIN NEW."id", so `creates_cycle` comes
--    back false and the re-parent is admitted. The failure is a silent false
--    negative in both directions of this pair.
CREATE OR REPLACE FUNCTION enforce_work_item_no_cycle()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
$$;

-- Triggers -------------------------------------------------------------------
-- Names sort cotenancy → cycle → depth → kind (see FIRING ORDER note above).
-- kind + depth fire on INSERT and on UPDATE of parentId/kind; cycle only matters
-- on a re-parent (a fresh INSERT cannot point at a row that points back at it),
-- so it fires on UPDATE of parentId only.
--
-- cotenancy watches THREE columns, not one: the invariant "parent shares my
-- workspace and project" breaks if the PARENT edge moves (parentId) or if the
-- CHILD's own tenancy columns move under a stationary edge. No shipped path
-- updates work_item."workspaceId" / "projectId" today — `workItemRepository`'s
-- update surface does not expose them — so the extra columns cost nothing and
-- close the case a future project-move feature would otherwise open silently.
-- (The trigger's NAME is chosen to sort first; "cotenancy" is the axis it
-- checks — parent and child holding the same tenancy.)
CREATE TRIGGER trg_work_item_cotenancy
  BEFORE INSERT OR UPDATE OF "parentId", "workspaceId", "projectId" ON "work_item"
  FOR EACH ROW EXECUTE FUNCTION enforce_work_item_parent_tenancy();

CREATE TRIGGER trg_work_item_cycle
  BEFORE UPDATE OF "parentId" ON "work_item"
  FOR EACH ROW EXECUTE FUNCTION enforce_work_item_no_cycle();

CREATE TRIGGER trg_work_item_depth
  BEFORE INSERT OR UPDATE OF "parentId", "kind" ON "work_item"
  FOR EACH ROW EXECUTE FUNCTION enforce_work_item_depth_limit();

CREATE TRIGGER trg_work_item_kind
  BEFORE INSERT OR UPDATE OF "parentId", "kind" ON "work_item"
  FOR EACH ROW EXECUTE FUNCTION enforce_work_item_kind_parent();
