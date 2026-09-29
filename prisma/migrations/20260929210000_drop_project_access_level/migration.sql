-- ===========================================================================
-- CONTRACT — drop the retired project access level (MOTIR-6694 · Epic
-- MOTIR-6164 · `docs/decisions/delivery-reader-migration.md` §6a / §6b).
--
-- A project's access lives in ONE column now: `project.access_mode` (Story
-- MOTIR-6169 · MOTIR-6541, NOT NULL since MOTIR-6686). What this drops has
-- decided nothing since the seven public-read policies were re-keyed onto the
-- mode (MOTIR-6687):
--
--   • `project."accessLevel"`    — the legacy browse-access level (Story 6.4);
--   • the `project_access_level` type it was typed by.
--
-- ⚠️ THIS IS THE THIRD PHASE OF THREE, AND THE ORDER IS THE WHOLE POINT.
--
--   1. EXPAND       (MOTIR-6687) no reader and no policy asks the level.
--   2. SCHEMA-ONLY  (MOTIR-6692) nothing writes it, the field is `@ignore`d so
--                   the generated client stopped selecting it — and RELEASED
--                   it, with the column in place.
--   3. CONTRACT     (this) drops the column and the type, and deletes the
--                   declarations in the same commit.
--
-- `fly.toml`'s `release_command` runs `prisma migrate deploy` BEFORE any new
-- machine takes traffic, so this drop is safe only because the still-serving
-- image is one whose client no longer names the column.
--
-- The marker below is `tests/contract-phase-guard.test.ts`'s declaration that
-- phase 2 has SHIPPED AND RELEASED. It was verified against the platform by
-- MOTIR-6693 (2026-09-29T20:05Z) before this migration was written:
-- @client-stopped-selecting: MOTIR-6692
--
--   • all 4 `motir-core` machines (release v839, the standby included) run
--     `GH_SHA=e82a5cc1b`, which contains MOTIR-6692's merge `adf0cc141`;
--   • the column was still present, and Sentry had no event naming it since
--     that merge.
--
-- Every migration that names the column — the access mapping (MOTIR-6542), the
-- NOT NULL contract (MOTIR-6686), the never-wider check (MOTIR-6461), the policy
-- re-key (MOTIR-6687) — sorts before this file.
-- ===========================================================================

-- 1. GUARD — refuse to run against a database that still depends on either.
--    A policy is the dependent that would otherwise surface only as a runtime
--    error: `DROP COLUMN` without CASCADE refuses a policy that names the column,
--    but the check makes the reason legible instead of a dependency error. A
--    second column typed `project_access_level` would make the `DROP TYPE`
--    fail after the column is already gone; a function body naming the column
--    would compile today and fail on its first call.
DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(format('%I.%I', tablename, policyname), ', ')
    INTO offenders
    FROM pg_policies
   WHERE coalesce(qual, '') ~ 'accessLevel|project_access_level'
      OR coalesce(with_check, '') ~ 'accessLevel|project_access_level';
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'MOTIR-6694: policies still read project."accessLevel": %', offenders;
  END IF;

  SELECT string_agg(format('%I.%I.%I', c.table_schema, c.table_name, c.column_name), ', ')
    INTO offenders
    FROM information_schema.columns c
   WHERE c.udt_name = 'project_access_level'
     AND NOT (c.table_schema = 'public' AND c.table_name = 'project' AND c.column_name = 'accessLevel');
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'MOTIR-6694: other columns are typed project_access_level: %', offenders;
  END IF;

  SELECT string_agg(format('%I.%I', n.nspname, p.proname), ', ')
    INTO offenders
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosrc ~ 'accessLevel|project_access_level';
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'MOTIR-6694: functions still name project."accessLevel": %', offenders;
  END IF;
END $$;

-- 2. AlterTable — the column before the type it is typed by.
ALTER TABLE "project" DROP COLUMN "accessLevel";

-- 3. DropEnum
DROP TYPE "project_access_level";
