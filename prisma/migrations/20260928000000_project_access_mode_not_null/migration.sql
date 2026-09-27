-- Project access mode NOT NULL — Release 1 of the retirement of
-- `project."accessLevel"` (Story MOTIR-6554 · Subtask MOTIR-6686).
--
-- MOTIR-6541 added `project.access_mode` NULLABLE with no default, beside the
-- legacy `accessLevel` (expand); MOTIR-6542's mapping migration
-- (`20260927000100_project_access_mapping`) filled it for every project that
-- existed then (migrate). Projects created SINCE were written with neither
-- column — `projectRepository.create` names neither — so they sit at
-- `access_mode` NULL, `accessLevel` 'open', and `accessModeOf` derived
-- `workspace` for them. This migration CONTRACTS the NULL state, in this order,
-- in the one transaction `migrate deploy` gives it:
--
--   1. SET DEFAULT 'workspace' — FIRST, so the ACCESS EXCLUSIVE lock it takes is
--      held across the whole backfill and no row can be inserted NULL between the
--      backfill and the constraint.
--   2. AGREEMENT CHECK — RAISE, naming up to ten project ids, if any row has a
--      non-NULL `access_mode` that is not what its `accessLevel` maps to. The
--      backfill below cannot fix such a row, and the reader card (MOTIR-6687)
--      would then move every public read onto whichever column was wrong.
--   3. BACKFILL every NULL from the level, by the DECISION's table
--      (`docs/decisions/role-model.md` Q1) — the same table as
--      `20260927000100_project_access_mapping` step 2, restated by value because
--      a migration is a point in time and must not import the application:
--      open → workspace, limited → members, private → members, public → public.
--   4. SET NOT NULL.
--
-- ⚠️ WHY THIS IS SAFE UNDER THE PREVIOUS IMAGE. `release_command` migrates while
-- the previous image (MOTIR-6169's, `cf47f2dd3` or later — verified serving by
-- MOTIR-6690) still takes traffic. That image creates projects with neither
-- column set, so the default gives them `workspace` — exactly what its own
-- `accessModeOf` derives for a NULL-mode `open` project. Its only other writer,
-- `setAccessMode`, writes both columns through `levelForMode`, so it can neither
-- insert a NULL nor produce a disagreeing pair. Nothing that image does can
-- violate the constraint or the agreement this migration checks.

-- 1. The default, first.
ALTER TABLE "project" ALTER COLUMN "access_mode" SET DEFAULT 'workspace';

-- 2 + 3. Refuse a disagreeing row, then fill every NULL.
DO $$
DECLARE
  disagreeing text;
  backfilled integer;
BEGIN
  SELECT string_agg(id, ', ' ORDER BY id)
    INTO disagreeing
    FROM (
      SELECT "id" AS id
        FROM "project"
       WHERE "access_mode" IS NOT NULL
         AND "access_mode" <> CASE "accessLevel"
               WHEN 'open'    THEN 'workspace'::"project_access_mode"
               WHEN 'limited' THEN 'members'::"project_access_mode"
               WHEN 'private' THEN 'members'::"project_access_mode"
               WHEN 'public'  THEN 'public'::"project_access_mode"
             END
       ORDER BY "id"
       LIMIT 10
    ) AS d;
  IF disagreeing IS NOT NULL THEN
    RAISE EXCEPTION 'MOTIR-6686: project access_mode disagrees with accessLevel for project(s): %', disagreeing
      USING HINT = 'Reconcile each project''s two columns (projectRepository.setAccessMode writes both) and re-deploy.';
  END IF;

  UPDATE "project"
     SET "access_mode" = CASE "accessLevel"
       WHEN 'open'    THEN 'workspace'::"project_access_mode"
       WHEN 'limited' THEN 'members'::"project_access_mode"
       WHEN 'private' THEN 'members'::"project_access_mode"
       WHEN 'public'  THEN 'public'::"project_access_mode"
     END
   WHERE "access_mode" IS NULL;
  GET DIAGNOSTICS backfilled = ROW_COUNT;
  RAISE NOTICE 'MOTIR-6686: % project(s) backfilled from accessLevel', backfilled;
END $$;

-- 4. The constraint.
ALTER TABLE "project" ALTER COLUMN "access_mode" SET NOT NULL;
