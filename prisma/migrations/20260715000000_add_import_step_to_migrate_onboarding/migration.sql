-- Add the OPTIONAL `import` step to the migrate-onboarding wizard state
-- machine (Story 7.15 · MOTIR-1643). The import step sits between `index` and
-- `audit_convention`; it is OPTIONAL — the user can complete an import or skip
-- it. Two new boolean columns track the skip / completion state (mutually
-- exclusive in practice; both false = import still pending, poll on every
-- advance).

-- AlterEnum — add `import` BEFORE `audit_convention` (the enum is ORDERED,
-- so ALTER TYPE … ADD VALUE's position matters).
ALTER TYPE "migrate_onboarding_step" ADD VALUE IF NOT EXISTS 'import' BEFORE 'audit_convention';

-- AlterTable — add the two boolean import-state columns.
ALTER TABLE "migrate_onboarding"
  ADD COLUMN "import_skipped" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "import_completed" BOOLEAN NOT NULL DEFAULT false;
