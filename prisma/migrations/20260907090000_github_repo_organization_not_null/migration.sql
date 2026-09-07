-- `github_repo.organization_id` BECOMES NOT NULL
-- Bug MOTIR-4700 · the follow-up MOTIR-4649 filed as a card rather than left as
-- a sentence in a migration comment.
--
-- MOTIR-4649 added the column NULLABLE and backfilled it to zero nulls. The
-- nullability was a DEPLOY-WINDOW property, never a model one: a migration runs
-- BEFORE the new pods serve, `github_repo` is written unattended by the
-- installation reconcile and by the `installation_repositories` webhook, and a
-- NOT NULL in that same migration would have failed every insert the OLD build
-- attempted in the window — silently dropping a repository selection nobody is
-- watching.
--
-- ⚠️ THE RELEASE CONDITION IS MET, AND IT WAS READ OFF THE PLATFORM RATHER THAN
-- OFF THIS REPOSITORY. `GET https://app.motir.co/api/health/release` answered
-- `39690bf7cc1075ea8f9aac534e665630d5c6b434` — which IS MOTIR-4649's own merge
-- commit (pull request #2664, merged 2026-09-07T01:04:21Z). The build that
-- predates the column is out of service, so the window this nullability existed
-- for is closed. Reading `main`, the migration history or an ADR could not have
-- said that: the state being asserted is the deployment's, and only the
-- deployment states it.
--
-- ⚠️ AND THE BACKFILL RE-RUNS FIRST, IDEMPOTENTLY. Between MOTIR-4649's deploy
-- and this one, every writer stamps the column
-- (`UpsertGithubRepoInput.organizationId` is required, and
-- `resolveOrganizationId` throws rather than returning null), so this UPDATE is
-- expected to touch zero rows. It runs anyway: a row written by anything that
-- bypassed those types — a hand-run SQL fix, a restored backup, a branch that
-- never shipped — would otherwise fail the ALTER at deploy time, which is the
-- one moment there is nobody to repair it.

UPDATE "github_repo" AS r
   SET "organization_id" = w."organizationId"
  FROM "workspace" AS w
 WHERE w."id" = r."workspace_id"
   AND r."organization_id" IS NULL;

-- AlterTable
ALTER TABLE "github_repo" ALTER COLUMN "organization_id" SET NOT NULL;

-- ⚠️ `github_installation.organization_id` IS DELIBERATELY UNTOUCHED, and its
-- NULL is the honest value rather than a backfill gap. Motir's SHARED
-- PROVISIONING INSTALLATION (MOTIR-1931) holds every tenant's Motir-created
-- repositories behind ONE installation: it serves N tenants and is owned by
-- none, so it can name neither a workspace nor an organisation. Its
-- `workspace_id` is nullable for exactly that reason, and the two columns
-- saying the same thing about that row is what makes the null readable. The
-- REPOSITORY rows it holds carry both tiers, which is why THIS column can be
-- tightened and that one cannot.
