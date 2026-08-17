-- MOTIR-2884 — enforce_work_item_link_workspace() must run SECURITY DEFINER.
-- ===========================================================================
-- `enforce_work_item_link_workspace()` (shipped by 20260531231110, source in
-- prisma/sql/work_item_link_triggers.sql) is the DB-layer backstop that refuses
-- a work_item_link whose two endpoints live in different workspaces
-- (WI_LINK_CROSS_WORKSPACE) and one whose denormalized workspaceId disagrees
-- with fromItem (WI_LINK_WORKSPACE_MISMATCH). It was a plain SECURITY INVOKER
-- plpgsql function whose body is two ordinary SELECTs against work_item.
--
-- Under the non-bypass runtime role (`motir_app`) those lookups are evaluated
-- under the INVOKING statement's policies. A writer is bound to exactly one
-- workspace, so the item in the OTHER workspace is invisible, the lookup reads
-- NULL, and the function takes its "defer to the FK" branch — while the FK is
-- satisfied, because the row exists (referential-integrity checks are exempt
-- from RLS). The insert SUCCEEDED and a cross-tenant link row was written. It
-- did not error and it did not log; it took a branch that says "somebody else
-- will catch this" about a case nobody else catches. The mismatch branch failed
-- the same way: bound to B while both endpoints live in A, BOTH lookups return
-- NULL and neither check is ever reached.
--
-- Measured on `TEST_DB_APP_ROLE=1` before this migration: the two trigger cases
-- in tests/integration/work-items/link-repository.test.ts, and the three new
-- bound-writer cases in tests/work-item-rls.test.ts, all fail with
-- `promise resolved … instead of rejecting`.
--
-- ---------------------------------------------------------------------------
-- WHY 1.4.5's VERDICT WAS RIGHT FOR FIVE FUNCTIONS AND WRONG FOR THIS ONE
-- ---------------------------------------------------------------------------
-- Both trigger source files carry a forward note to Subtask 1.4.5:
--
--   "Within a single workspace every link's referenced items share one
--    workspaceId, so the active app.workspace_id GUC will match — but 1.4.5
--    must verify this and, if needed, mark these functions SECURITY DEFINER."
--
-- 1.4.5 answered "no SECURITY DEFINER needed", as a GROUP verdict, and for the
-- five same-tenant integrity triggers it is still right. It is wrong for
-- exactly one function, for a structural reason: **a cross-workspace check is
-- the one whose job is to look at a row in another tenant.** The premise "every
-- row the trigger walks shares the active GUC" is the NEGATION of what this
-- trigger tests, so the group the verdict was written for excluded, by its own
-- wording, the member the group was named after.
--
-- It survived because every test that exercised it wrote as the OWNER, where
-- the trigger works perfectly. The role that breaks it is the role no test used
-- until the suite began running as `motir_app`.
--
-- ---------------------------------------------------------------------------
-- THE PER-FUNCTION VERDICT (record it here so the next reader inherits it)
-- ---------------------------------------------------------------------------
-- The question is NOT "does the trigger fire". It is: **can a row this
-- function's internal lookups must SEE lie outside the invoking context?** The
-- context has TWO narrowing axes, not one — `work_item` carries the PERMISSIVE
-- `work_item_active_workspace` gate (app.workspace_id) AND the RESTRICTIVE
-- `work_item_project_narrow` FOR SELECT policy (app.project_id), so a bound
-- PROJECT hides in-workspace rows from a lookup too. `work_item_link` carries
-- the workspace gate only (cross-project links inside one workspace are a v1
-- use case), so link walks have one axis.
--
--   1. enforce_work_item_link_no_self      — reads NO rows at all; its whole
--      body is `NEW."fromId" = NEW."toId"`. Nothing to hide. IMMUNE by
--      construction, in any role, under any GUC.
--
--   2. enforce_work_item_link_no_cycle     — walks `work_item_link` rows via a
--      recursive CTE. No project narrowing on that table, and every link in a
--      well-formed graph carries the workspaceId of its endpoints, so the whole
--      walk is in-context. NO definer needed — **but note the direction of the
--      dependency**: that walk is complete only because cross-workspace links
--      cannot exist, which is the invariant function 3 enforces. While 3 was
--      inert, cross-workspace link rows COULD be written, and a cycle path
--      through one would have been invisible to this CTE. Fixing 3 is what
--      makes this verdict true rather than merely stated.
--
--   3. enforce_work_item_link_workspace    — **YES, structurally.** Its subject
--      IS a row in another tenant: a genuine WI_LINK_CROSS_WORKSPACE violation
--      places one endpoint outside the writer's workspace by construction, and
--      a WI_LINK_WORKSPACE_MISMATCH violation can place BOTH outside it. The
--      project axis hits it too: with app.project_id bound, a LEGAL
--      cross-project link's far endpoint is hidden and the check is skipped
--      rather than performed. **This is the function this migration fixes.**
--
--   4. enforce_work_item_kind_parent       — reads the parent row by id to get
--      its `kind`. In-context iff the parent shares the bound workspace (and
--      the bound project, when app.project_id is set). A parent in a foreign
--      workspace or project reads NULL, the function defers to the FK, and the
--      kind matrix silently does not apply.
--   5. enforce_work_item_depth_limit       — walks the ancestor chain upward.
--      A chain that leaves the bound context TRUNCATES, so the computed depth
--      under-counts and a too-deep insert can pass.
--   6. enforce_work_item_no_cycle          — same walk, same truncation; a
--      cycle through an out-of-context ancestor would go undetected.
--
--      **Verdict for 4–6: their in-context premise is real but it rests on a
--      SERVICE-layer invariant, not a database one.** Same-project parenting is
--      enforced by `workItemsService` (`CrossProjectParentError`, on create and
--      on both re-parent paths) and nothing in the database compares
--      parent.workspaceId or parent.projectId with the child's. So the DB
--      backstop's completeness depends on the application check it exists to
--      backstop — which is circular, and is a real finding. It is NOT fixed by
--      marking these three SECURITY DEFINER: a definer lookup would restore the
--      KIND / DEPTH / CYCLE checks while still ADMITTING the cross-tenant
--      parentId, which is the actual hole and which is equally open under the
--      owner role. Making them definer would therefore make an unguarded case
--      LOOK guarded. Filed as its own card rather than absorbed here (the fix
--      is a new DB-level parent-tenancy check, not a security label).
--
-- ---------------------------------------------------------------------------
-- WHAT SECURITY DEFINER BUYS, AND WHAT IT COSTS
-- ---------------------------------------------------------------------------
-- The function is re-created with SECURITY DEFINER and a pinned
-- `SET search_path = public, pg_temp`. A SECURITY DEFINER function without a
-- pinned search_path is the standard privilege-escalation shape (a caller
-- prepends a schema and captures an unqualified reference); pinning it, with
-- pg_temp LAST, closes that.
--
-- The widened reach is bounded and leaks nothing: the body reads exactly two
-- `workspaceId` columns by PRIMARY KEY and returns no data to the caller — the
-- only observable outputs are the two RAISEs, which report a workspace id the
-- caller supplied the row for. Nor is it directly callable: a `RETURNS trigger`
-- function cannot be invoked from SQL ("trigger functions can only be called as
-- triggers"), so there is no call surface to REVOKE.
--
-- ⚠️ The reach it gains comes from the OWNER's `BYPASSRLS` attribute, not from
-- ownership as such. `work_item` is FORCE ROW LEVEL SECURITY, which subjects
-- even the table owner to its policies; what defeats FORCE is the BYPASSRLS
-- role attribute, which the migration-executing owner has in every environment
-- we deploy to (`neondb_owner` in production — measured 2026-08-07 — and the
-- local/CI superuser). If this function's owner were ever changed to a
-- NOBYPASSRLS role, the definer switch alone would NOT restore the lookups and
-- this defect would return in exactly its original silent form. That dependency
-- is the reason it is written down here rather than left to be re-derived.
--
-- CREATE OR REPLACE preserves the existing `trg_work_item_link_workspace`
-- trigger binding — the body and the security label change, the trigger does
-- not need to be dropped or re-created.

CREATE OR REPLACE FUNCTION enforce_work_item_link_workspace()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  from_workspace text;
  to_workspace   text;
BEGIN
  -- SECURITY DEFINER (MOTIR-2884): these two lookups MUST be able to address a
  -- row in another workspace / project. Under SECURITY INVOKER the far endpoint
  -- read NULL for a bound `motir_app` writer and the deferral branch below let
  -- the cross-tenant insert through.
  SELECT w."workspaceId" INTO from_workspace FROM "work_item" w WHERE w."id" = NEW."fromId";
  SELECT w."workspaceId" INTO to_workspace   FROM "work_item" w WHERE w."id" = NEW."toId";

  -- Defer genuinely missing-row cases to the FK constraint. With the lookups
  -- now unfiltered, NULL means the row does not exist — it no longer also means
  -- "the row exists but you cannot see it", which is what made this branch a
  -- silent hole.
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
$$;
