-- MOTIR-2895 — the database must check a work item's parent TENANCY.
-- ===========================================================================
-- The other half of MOTIR-2884. That card asked, per trigger function, "can a
-- row this function's internal lookups must SEE lie outside the invoking
-- context?" and found the answer was yes for one of six. Writing the verdict
-- for the three `work_item` parent-chain functions (4–6 in that migration)
-- surfaced something the question was not aimed at: their in-context premise —
-- *within a single subtree every row shares one workspaceId* — is TRUE, and it
-- is true because `workItemsService` refuses a cross-project parent
-- (`CrossProjectParentError`, on create at workItemsService.ts:724 and on both
-- re-parent paths, :1439 and :2515). **Nothing in the database compared
-- parent."workspaceId" or parent."projectId" with the child's.**
--
-- So the DB backstop's completeness rested on the application check it exists to
-- backstop. That is circular, and the circularity is the defect: the whole
-- argument for paying for a trigger is that it holds when everything above it is
-- wrong, and the scenarios these triggers were installed for — a direct SQL
-- write, a future code path that forgets the check — are exactly the scenarios
-- in which the premise is not available.
--
-- It is ALSO not an RLS regression. Under the owner role the walks are complete
-- and a cross-tenant `parentId` is admitted just the same; RLS only widens the
-- consequence (the checks additionally stop applying). This has been reachable
-- since Subtask 1.4.2 shipped in 2026-05, and 1.4.2's own forward note said the
-- load-bearing part out loud — *"the service enforces same-project parenting"* —
-- and read it as reassurance.
--
-- ---------------------------------------------------------------------------
-- WHY SECURITY DEFINER ON 4–6 WOULD NOT HAVE BEEN THE FIX
-- ---------------------------------------------------------------------------
-- MOTIR-2884 could have marked all six functions SECURITY DEFINER in one line
-- and every one of its own tests would have gone green. It deliberately did not,
-- and the reason is worth keeping: a definer lookup in the kind / depth / cycle
-- functions restores those three checks over a cross-tenant parent chain **while
-- still ADMITTING the cross-tenant parentId.** The row lands, correctly
-- kind-checked, correctly depth-checked, and still a child of another tenant's
-- item. A guard that examines the right things about the wrong row is worse than
-- an absent one, because the next reader sees a check and stops looking.
--
-- The missing piece was a check that did not exist. This migration adds it.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS MIGRATION DOES
-- ---------------------------------------------------------------------------
--   0. ASSERTS that no existing row violates the invariant (below).
--   1. Adds `enforce_work_item_parent_tenancy()` + `trg_work_item_cotenancy` —
--      SECURITY DEFINER, `search_path` pinned, firing FIRST of the four.
--   2. Re-creates `enforce_work_item_kind_parent`, `enforce_work_item_depth_limit`
--      and `enforce_work_item_no_cycle` as SECURITY DEFINER, bodies UNCHANGED —
--      the amendment to 20260817120000's verdict for functions 4–6, argued below.
--
-- Source of record for all four function bodies: prisma/sql/work_item_triggers.sql.
--
-- ---------------------------------------------------------------------------
-- THE AMENDED VERDICT FOR FUNCTIONS 4–6 (kind / depth / cycle)
-- ---------------------------------------------------------------------------
-- 20260817120000 left these three SECURITY INVOKER and named the reason they
-- were *tolerable* rather than *right*. The card that filed this work expected
-- the new check to let them stay INVOKER "on evidence instead of on trust". Half
-- of that expectation holds, and the deciding half does not — and the split is
-- along the two narrowing axes, not along the three functions:
--
--   * The WORKSPACE axis closes completely. `work_item_active_workspace` is
--     PERMISSIVE FOR ALL with `USING`/`WITH CHECK` on
--     `"workspaceId" = app.workspace_id`, so RLS itself pins the WRITTEN row's
--     workspace to the bound one, and the new check pins the parent's to the
--     written row's. By induction the entire ancestor chain shares the bound
--     workspace, so the permissive gate admits all of it. This is now a database
--     invariant, exactly as the card predicted.
--
--   * The PROJECT axis does NOT close, because `work_item_project_narrow` is
--     RESTRICTIVE **FOR SELECT only** (by design — 20260601074342 explains why
--     narrowing writes was not worth reasoning about). Nothing therefore pins
--     the written row's project to `app.project_id`: a caller bound to project P
--     may legally INSERT a row into project Q of the same workspace, and an
--     invoker walk from that row truncates at its first ancestor. **Chain TENANCY
--     is not chain VISIBILITY.**
--
--     Nor is that a shape kept alive for symmetry. A scan of
--     `withWorkspaceContext(` call sites passing a NON-EMPTY `projectId` returns
--     **39**, of which **26 are in `lib/`**: `plansService` (6),
--     `migrateOnboardingService` (5), the `projectRepo*` services (10),
--     `projectAccessService` (2), `planChangeSessionsService` (2),
--     `autoPlanCadenceService` (1) — plus one `scripts/` caller and 12 in
--     `tests/`. `plansService` and `migrateOnboardingService` are precisely the
--     paths that WRITE work-item trees with parents. They happen to write into the
--     project they bind — which is exactly the convention an INVOKER verdict would
--     have to depend on.
--
-- MEASURED, rather than argued. A writer bound to (W1, P1), a legal 4-deep chain
-- sitting in W1/P1b, the three functions as SECURITY INVOKER:
--
--   | write                                            | outcome under INVOKER          |
--   |--------------------------------------------------|--------------------------------|
--   | ORM create (RETURNING) of a 5th level into P1b   | rejected — BY RLS, not by the  |
--   |                                                  | trigger: "new row violates     |
--   |                                                  | row-level security policy      |
--   |                                                  | work_item_project_narrow"      |
--   | raw INSERT (no RETURNING), 5th level into P1b    | **ACCEPTED, row landed**       |
--   | raw INSERT (no RETURNING), kind-illegal parent    | **ACCEPTED, row landed**       |
--   | raw UPDATE re-parent, WHERE id = <a P1b row>     | 0 rows — the restrictive       |
--   |                                                  | SELECT policy hides the row    |
--   |                                                  | from the UPDATE itself         |
--   | raw UPDATE re-parent with NO WHERE (reads no      | REACHED the P1b rows (the kind |
--   | existing column value)                           | trigger fired on one)          |
--
-- Read that table carefully, because it says two things at once.
--
--   1. **The kind and depth holes are real and they land rows.** Both raw INSERTs
--      were accepted with the illegal row written. They are the two new cases in
--      tests/work-item-rls.test.ts, and they are the direct evidence for the
--      DEFINER label on functions 4 and 5.
--   2. **The ORM path was MASKED, which is why nothing noticed.** Prisma's create
--      always emits RETURNING, and the same restrictive policy rejects the
--      RETURNED row — so through the ORM this shape fails with an RLS error and
--      the trigger's silent under-count is never observed. A "direct SQL write"
--      is the FIRST scenario the trigger file names as why these triggers exist,
--      and it is the one where the masking is absent.
--
-- Function 6 (cycle) is the near-miss and is worth stating precisely: it fires
-- only on UPDATE OF "parentId", and an UPDATE that reads any existing column
-- value has the restrictive SELECT policy applied to its row lookup, so a row
-- whose chain an invoker cannot walk is a row it cannot update (0 rows, row 4).
-- Given parent tenancy, an UPDATE that DOES find its row can also see every
-- ancestor of it. That is a genuine database-invariant argument, and it is the
-- one the card predicted. It is defeated only by row 5 — a statement that reads
-- no existing column value at all reaches rows outside the bound project, and
-- then the cycle walk truncates like the others. So the verdict for 6 is DEFINER
-- as well, but on a narrower and more contrived reachability than 4 and 5, and
-- that difference is recorded rather than flattened.
--
-- Leaving any of the three SECURITY INVOKER would re-seat its completeness on an
-- application-layer convention (callers binding the row's own project, callers
-- always writing through the ORM) one step out from the convention this card
-- exists to remove. So all four are SECURITY DEFINER.
--
-- WHAT THAT COSTS, AND WHY IT IS BOUNDED. The objection 2884 raised does not
-- apply once the tenancy check exists, and the FIRING ORDER is what discharges
-- it. Postgres fires per-row BEFORE triggers in alphabetical order by trigger
-- NAME, and the names sort `cotenancy` → `cycle` → `depth` → `kind`. A
-- cross-tenant `parentId` therefore aborts the statement BEFORE kind / depth /
-- cycle read anything at all: their widened lookups can only ever address rows
-- that share the writing row's workspace and project. They cannot be used to
-- probe another tenant, and nothing they RAISE can carry another tenant's data.
-- (`trg_work_item_cotenancy`'s own name is chosen for that sort position; the
-- ordering is load-bearing for this security argument, not cosmetic.)
--
-- The other two standing caveats from 20260817120000 hold here unchanged:
--   * `SET search_path = public, pg_temp` on every definer function — an
--     unpinned definer is the standard privilege-escalation shape (a caller
--     prepends a schema and captures an unqualified reference), and pg_temp last
--     closes it.
--   * ⚠️ The widened reach comes from the OWNER's `BYPASSRLS` **attribute**, not
--     from ownership: `work_item` is FORCE ROW LEVEL SECURITY, which subjects
--     even its owner to its policies. `neondb_owner` in production (measured
--     2026-08-07) and the local/CI superuser both have it. If these functions'
--     owner were ever changed to a NOBYPASSRLS role, the definer label alone
--     would NOT restore the lookups and both defects would return in their
--     original silent form.
--
-- Not directly callable, so there is no call surface to REVOKE: a
-- `RETURNS trigger` function cannot be invoked from SQL ("trigger functions can
-- only be called as triggers").
--
-- ---------------------------------------------------------------------------
-- THE MARKERS
-- ---------------------------------------------------------------------------
-- Two, so the rejection says WHICH boundary was crossed:
--   WI_PARENT_CROSS_WORKSPACE — parent in another workspace (the coarser
--                               boundary; checked first, since a parent in
--                               another workspace is also in another project and
--                               reporting the project would name the smaller of
--                               two violations).
--   WI_PARENT_CROSS_PROJECT   — parent in another project of the same workspace.
--
-- Both translate at the repository edge to `CrossProjectParentError` — the typed
-- error `workItemsService` ALREADY throws for this rule, on all three of its
-- paths. That is deliberate: the service check is not replaced, it is backstopped,
-- and a caller must not have to learn a second vocabulary depending on which
-- layer caught the same mistake. (`workItemRepository.translateWriteError`.)

-- 0. The invariant must already hold ----------------------------------------
--    A BEFORE trigger validates writes, not history, so if any row already
--    carries a cross-tenant parent it would survive silently AND falsify the
--    induction the 4–6 verdict above rests on. Every shipped write path has gone
--    through `workItemsService`'s check, so the expected count is 0 in every
--    environment; a non-zero count is real tenancy corruption and a failed
--    migration is the correct alarm for it. Measured 0 locally against a
--    `migrate deploy` replay of origin/main.
DO $$
DECLARE
  offenders text;
  offender_count int;
BEGIN
  SELECT count(*), string_agg(c."id" || ' → ' || c."parentId", ', ' ORDER BY c."id")
    INTO offender_count, offenders
    FROM "work_item" c
    JOIN "work_item" p ON p."id" = c."parentId"
   WHERE p."workspaceId" <> c."workspaceId"
      OR p."projectId"   <> c."projectId";

  IF offender_count > 0 THEN
    RAISE EXCEPTION 'MOTIR-2895: % work_item row(s) already carry a cross-tenant parent and must be repaired before this check can be installed: %',
      offender_count, offenders;
  END IF;
END;
$$;

-- 1. The new check -----------------------------------------------------------
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

-- Watches THREE columns: the invariant breaks if the parent EDGE moves
-- (parentId) or if the child's own tenancy columns move under a stationary edge.
-- No shipped path updates work_item."workspaceId" / "projectId" today, so the
-- extra columns cost nothing and close the case a future project-move feature
-- would otherwise open silently. The NAME sorts first of the four (see above).
CREATE TRIGGER trg_work_item_cotenancy
  BEFORE INSERT OR UPDATE OF "parentId", "workspaceId", "projectId" ON "work_item"
  FOR EACH ROW EXECUTE FUNCTION enforce_work_item_parent_tenancy();

-- 2. Functions 4–6 re-created as SECURITY DEFINER ----------------------------
--    Bodies UNCHANGED from 20260530230912 (source: prisma/sql/work_item_triggers.sql).
--    CREATE OR REPLACE preserves the existing trg_work_item_kind / _depth /
--    _cycle bindings — the security label changes, the triggers do not need to be
--    dropped or re-created.

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
  -- error rather than masking it with a parent-type rejection. With the lookup
  -- now unfiltered, NULL means the row does not exist.
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
