-- MOTIR-4934 — the project's BUG DESTINATION pointer.
-- ===========================================================================
-- Story MOTIR-4927. A filed bug has to land somewhere, and today "somewhere" is
-- a project-wide title match against a row the `ensure_planner_bug_home` data
-- migration created ONCE (`lib/ai/plannerBugHome.ts` says so in its own header:
-- "a migration runs EXACTLY ONCE per database: it is a one-shot backfill, not a
-- standing guarantee"). This migration adds the column that replaces that
-- lookup. It adds NO readers — the resolver (MOTIR-4937), the creation-path
-- seed (MOTIR-4935), the backfill (MOTIR-4936) and the settings picker
-- (MOTIR-4938) are siblings blocked on this one.
--
-- ---------------------------------------------------------------------------
-- `NULL` IS A VALUE, NOT AN ABSENCE
-- ---------------------------------------------------------------------------
-- Three states in one nullable column:
--
--   a work-item id -> file bugs under that container
--   NULL           -> file bugs at the PROJECT ROOT, parentless
--
-- The root case is a first-class choice a person makes in project settings, and
-- a team that has just connected a monitor is the one most likely to want it.
-- So: nullable, and **no non-null default**. A later migration that adds a
-- default, or makes the column required "for safety", silently overwrites every
-- team that chose the root. That is the one change this column must never take.
--
-- ---------------------------------------------------------------------------
-- WHY `ON DELETE SET NULL`
-- ---------------------------------------------------------------------------
-- The same shape, for the same reason, as `project.primary_address_id`
-- (20260903010000). Deleting a container must not cascade into the project, and
-- must not leave a dangling id either: a dangling id makes EVERY reader
-- responsible for re-checking existence, and the story's own acceptance
-- criterion is that a destination pointing at a deleted item resolves to the
-- root. SET NULL puts that truth IN the column, so MOTIR-4937's fallback reads a
-- fact rather than inferring one from a lookup miss.
--
-- (The ARCHIVED case is deliberately NOT handled here: archiving is a soft
-- remove that leaves the row, so no FK action can see it. That branch belongs to
-- the resolver, which is where the story puts it.)
--
-- ---------------------------------------------------------------------------
-- WHY A TRIGGER FOR THE CROSS-PROJECT CHECK, AND WHY IT IS `SECURITY DEFINER`
-- ---------------------------------------------------------------------------
-- The card requires that a pointer at a work item in ANOTHER project be
-- rejected, and says to name the layer. It is rejected **at the database**.
--
-- A plain foreign key cannot express it: the constraint that would — a composite
-- FK `(id, bug_destination_id) -> work_item(project_id, id)` — is not
-- expressible as a Prisma `@relation` whose delete action is SET NULL, because
-- the column-list SET NULL would have to null `project.id` as well. Modelling it
-- in raw SQL only is precisely the drift `CLAUDE.md`'s FK rule forbids (every
-- later `migrate dev` re-proposes `DROP CONSTRAINT` for an FK the datamodel does
-- not carry). So the FK stays simple and modelled, and the tenancy comparison is
-- a trigger — the mechanism this repository already uses for exactly this
-- question, in `20260817160000_work_item_parent_tenancy`.
--
-- SECURITY DEFINER, `search_path` pinned, for that migration's own reason and it
-- is the load-bearing one: the lookup must be UNFILTERED. Under an invoker label
-- the `work_item` RLS policies hide a row in another workspace, the lookup
-- returns NULL, and the "row does not exist, defer to the FK" branch ADMITS the
-- very write the check exists to refuse — a guard that examines the right thing
-- about a row it cannot see. With the lookup unfiltered, NULL means "no such
-- row" and nothing else.
--
-- ⚠️ The widened reach comes from the owner's BYPASSRLS ATTRIBUTE, not from
-- ownership: `work_item` is FORCE ROW LEVEL SECURITY. If these functions' owner
-- were ever changed to a NOBYPASSRLS role, the DEFINER label alone would not
-- restore the lookup and the hole would return in its original silent form.
--
-- TWO markers, so the rejection says WHICH boundary was crossed — and the
-- workspace one is checked first, because a container in another workspace is
-- also in another project and reporting the project would name the smaller of
-- two violations. Both use ERRCODE 23514, as the work_item triggers do.
--
-- No step-0 backfill assertion (the `work_item_parent_tenancy` migration has
-- one): the column is CREATED by this migration, so every existing row carries
-- NULL and there is nothing that could already violate the invariant.
--
-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- NOTHING IS ADDED, and that is the correct outcome rather than an omission.
-- `project` already carries `project_workspace_or_system_read` — a PERMISSIVE
-- `FOR ALL` policy whose WITH CHECK is
-- `"workspaceId" = current_setting('app.workspace_id', true)`, under ENABLE +
-- FORCE ROW LEVEL SECURITY. (Originally `project_active_workspace` in
-- 20260529202445; renamed and given its system-admin read arm by
-- 20260727225458, which is the name in the catalog TODAY — read from
-- `pg_policies`, not from the migration that first created it.) The other two
-- arms are SELECT-only and cannot admit a write.
--
-- A policy governs the ROW, so a new column on that row is covered the moment it
-- exists: under the non-bypass `motir_app` role a caller bound to workspace A
-- cannot UPDATE this column on a project in workspace B. Authoring a second,
-- column-specific policy would be inventing a new shape where the card says to
-- match the shipped one. Asserted by a test rather than by this paragraph
-- (`tests/projects/bugDestinationColumn.test.ts`), and asserted in BOTH
-- directions — the in-workspace write is proved to SUCCEED first, or "refused"
-- would be indistinguishable from a column the runtime role cannot write.

-- 1. The column -------------------------------------------------------------
ALTER TABLE "project" ADD COLUMN "bug_destination_id" TEXT;

-- The delete of a container SET NULLs this column, so that delete scans
-- `project` for referencing rows. Also declared as `@@index([bugDestinationId])`
-- in the datamodel — a DB index the schema does not carry is drift the `build`
-- job's `prisma migrate diff --exit-code` fails on.
CREATE INDEX "project_bug_destination_id_idx" ON "project"("bug_destination_id");

ALTER TABLE "project"
  ADD CONSTRAINT "project_bug_destination_id_fkey"
  FOREIGN KEY ("bug_destination_id") REFERENCES "work_item"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 2. The tenancy check -------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_project_bug_destination_tenancy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  destination_workspace text;
  destination_project   text;
BEGIN
  -- NULL is the ROOT destination, and it is always legal.
  IF NEW."bug_destination_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT w."workspaceId", w."projectId"
    INTO destination_workspace, destination_project
    FROM "work_item" w
   WHERE w."id" = NEW."bug_destination_id";

  -- Genuinely missing: defer to the foreign key, which gives the clearer error.
  -- This lookup is UNFILTERED (the DEFINER label above), so NULL here means "no
  -- such row" and no longer also means "the row exists but you cannot see it".
  IF destination_workspace IS NULL THEN
    RETURN NEW;
  END IF;

  IF destination_workspace <> NEW."workspaceId" THEN
    RAISE EXCEPTION 'PROJECT_BUG_DESTINATION_CROSS_WORKSPACE: work item % lives in workspace %, not % — a project''s bug destination must belong to the same workspace',
      NEW."bug_destination_id", destination_workspace, NEW."workspaceId"
      USING ERRCODE = '23514';
  END IF;

  IF destination_project <> NEW."id" THEN
    RAISE EXCEPTION 'PROJECT_BUG_DESTINATION_CROSS_PROJECT: work item % lives in project %, not % — a project''s bug destination must be one of its own work items',
      NEW."bug_destination_id", destination_project, NEW."id"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

-- Watches the pointer AND the project's own tenancy column: the invariant breaks
-- if the pointer moves, or if `workspaceId` moves under a stationary pointer. No
-- shipped path updates `project."workspaceId"` today, so the extra column costs
-- nothing and closes the case a future project-move feature would otherwise open
-- silently. (`project."id"` is the PK and cannot move, so it is not watched.)
CREATE TRIGGER trg_project_bug_destination_tenancy
  BEFORE INSERT OR UPDATE OF "bug_destination_id", "workspaceId" ON "project"
  FOR EACH ROW EXECUTE FUNCTION enforce_project_bug_destination_tenancy();
