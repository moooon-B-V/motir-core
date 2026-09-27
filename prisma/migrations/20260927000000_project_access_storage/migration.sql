-- Project access storage — the EXPAND step (Story MOTIR-6169 · Subtask MOTIR-6541).
--
-- Access moves onto the project as one of three MODES — Open to the workspace ·
-- Members only · Public — and each workspace membership gains an access SCOPE,
-- Full or Limited (`docs/decisions/role-model.md` Q1). This migration only makes
-- room for that model, BESIDE the legacy `project."accessLevel"`, in the same
-- expand → migrate → contract sequence the workspace roles used (MOTIR-6457):
--
--   1. `project_access_mode` / `workspace_access_scope` enums;
--   2. `project.access_mode` — NULLABLE, NO default;
--   3. `workspace_membership.access_scope` — NOT NULL, DEFAULT 'full';
--   4. `role_migration_reason` gains `project_access_lost`.
--
-- NOTHING IS BACKFILLED AND NOTHING READS THE NEW COLUMNS YET. The access
-- migration (MOTIR-6542) fills `access_mode`; the entry rule (MOTIR-6543) reads
-- both. So the release this ships in changes no behaviour, and old and new code
-- both run against this schema.
--
-- `access_mode` deliberately has NO default: a default would hand `workspace`
-- to a project the still-serving old build creates `private` during the deploy
-- window. NULL is read as "derive from `accessLevel`" (`accessModeOf`,
-- `lib/projects/accessMode.ts`). `access_scope` DOES default to 'full', because
-- nobody before this story was restricted — 'full' is the right value for every
-- row the old build inserts.
--
-- The added enum value cannot be USED in the transaction that adds it, which is
-- why the migration that writes `project_access_lost` rows is its own file.
--
-- RLS: both columns sit on tables that already carry their policies
-- (`project_active_workspace`, `membership_visible_active_or_own`), so no policy
-- is added. The public-read policies keyed on `"accessLevel" = 'public'` stay
-- correct because `projectRepository.setAccessMode` writes both columns.

-- CreateEnum
CREATE TYPE "project_access_mode" AS ENUM ('workspace', 'members', 'public');

-- CreateEnum
CREATE TYPE "workspace_access_scope" AS ENUM ('full', 'limited');

-- AlterEnum
ALTER TYPE "role_migration_reason" ADD VALUE 'project_access_lost';

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "access_mode" "project_access_mode";

-- AlterTable
ALTER TABLE "workspace_membership" ADD COLUMN     "access_scope" "workspace_access_scope" NOT NULL DEFAULT 'full';
