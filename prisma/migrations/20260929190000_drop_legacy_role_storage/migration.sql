-- ===========================================================================
-- CONTRACT — drop the retired role storage (MOTIR-6569 · Epic MOTIR-6164 ·
-- `docs/decisions/delivery-reader-migration.md` §6a / §6b).
--
-- A person's role lives in ONE place now: `workspace_membership.workspace_role`
-- + `role_definition_id` (Story MOTIR-6168). What this drops has decided nothing
-- since that story's mapping ran:
--
--   • `workspace_membership.role`           — the legacy workspace role;
--   • `project_membership.role`             — the legacy project role;
--   • `project_membership.role_definition_id` and its FK;
--   • `project_role_definition`             — the project custom-role table,
--                                             with its RLS policy and indexes;
--   • the `member_role` type the three role columns used.
--
-- `project_membership` ROWS survive (they are who is in a project), and so does
-- `role_migration_report` (the Members page reads it).
--
-- ⚠️ THIS IS THE THIRD PHASE OF THREE, AND THE ORDER IS THE WHOLE POINT.
--
--   1. EXPAND       (MOTIR-6562) nothing writes the legacy columns, and
--                   `MemberRole` left application code.
--   2. SCHEMA-ONLY  (MOTIR-6567) `@ignore`d the fields and `@@ignore`d
--                   `ProjectRoleDefinition`, so the generated client stopped
--                   selecting them — and RELEASED it, every column in place.
--   3. CONTRACT     (this) drops them, and deletes the declarations in the same
--                   commit.
--
-- `fly.toml`'s `release_command` runs `prisma migrate deploy` BEFORE any new
-- machine takes traffic, so this drop is safe only because the still-serving
-- image is one whose client no longer names the columns or the table.
--
-- The marker below is `tests/contract-phase-guard.test.ts`'s declaration that
-- phase 2 has SHIPPED AND RELEASED. It was verified against the platform by
-- MOTIR-6568 (2026-09-29T18:39Z) before this migration was written:
-- @client-stopped-selecting: MOTIR-6567
--
--   • `fly releases`: v836 `complete`, none pending or failed; all 4 machines
--     (app ×2, worker, standby worker) on it, one image digest
--     `sha256:484bcb2c…fc311029`;
--   • that image's `GH_SHA` is `a8e920cc5`, which contains MOTIR-6567's merge
--     `3517240` (`git merge-base --is-ancestor`), and its `schema.prisma`
--     declares every dropped field `@ignore` and the model `@@ignore`.
--
-- MOTIR-6542's access mapping (20260927000100_project_access_mapping) reads
-- `workspace_membership.role` in SQL, so it must have run first — it sorts
-- before this file, as does every other migration naming a dropped object.
--
-- ORDER — the one Postgres accepts: the FK before the table it points at, the
-- columns before the type they are typed by, the table before nothing (the
-- policy and the indexes go with it).
-- ===========================================================================

-- DropForeignKey
ALTER TABLE "project_membership" DROP CONSTRAINT "project_membership_role_definition_id_fkey";

-- AlterTable — the index `project_membership_role_definition_id_idx` goes with the column.
ALTER TABLE "project_membership" DROP COLUMN "role_definition_id",
DROP COLUMN "role";

-- AlterTable
ALTER TABLE "workspace_membership" DROP COLUMN "role";

-- DropTable — its RLS policy `project_role_definition_active_workspace`, its
-- indexes and its two FKs (to `workspace` and `project`) go with it.
DROP TABLE "project_role_definition";

-- DropEnum
DROP TYPE "member_role";
