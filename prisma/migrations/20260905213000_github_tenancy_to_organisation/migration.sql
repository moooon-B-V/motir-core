-- THE REPOSITORY'S TENANCY MOVES TO THE ORGANISATION
-- Story MOTIR-4669 · subtask MOTIR-4649.
--
-- A repository is connected ONCE, to the ORGANISATION, and which projects use it
-- is visibility configuration — MOTIR-2029's rule for the code graph, applied to
-- the thing the graph is built FROM. Today `github_installation.workspace_id` and
-- `github_repo.workspace_id` are the tenancy, so two workspaces of one
-- organisation connecting the same repository are two connections and two graphs
-- built from identical bytes.
--
-- ⚠️ THIS MIGRATION IS DELIBERATELY BORING, AND THE BORINGNESS IS THE POINT.
-- It adds two columns, two foreign keys, two indexes and a backfill. It edits NO
-- ROW-LEVEL SECURITY POLICY — that is MOTIR-4677's card. A migration that moved
-- the column AND rewrote the policies would be untestable in the way that
-- matters: nothing in its diff would tell you whether a failure came from the
-- column or from the policy, and one of those two failure modes is a
-- data-exposure bug.
--
-- ⚠️ ADDITIVE AND NULLABLE, WHICH IS A DEPLOY-WINDOW PROPERTY RATHER THAN A MODEL
-- ONE. `github_repo` is written unattended by the installation reconcile and by
-- the webhook, and a migration runs BEFORE the new pods serve. A NOT NULL here
-- would make every insert the OLD build attempts in that window fail — so the
-- shape is nullable → backfill → (later) tighten. Every writer in the new build
-- stamps the column, so a row written in the window is not left null either.
--
-- The `workspace_id` columns are KEPT and stay non-null on `github_repo`: they
-- are the tier a repository is connected FROM, and they are what the shipped RLS
-- policies still key on until MOTIR-4677 rewrites them. Nothing is dropped here.

-- AlterTable
ALTER TABLE "github_installation" ADD COLUMN     "organization_id" TEXT;

-- AlterTable
ALTER TABLE "github_repo" ADD COLUMN     "organization_id" TEXT;

-- CreateIndex
CREATE INDEX "github_installation_organization_id_idx" ON "github_installation"("organization_id");

-- CreateIndex
CREATE INDEX "github_repo_organization_id_idx" ON "github_repo"("organization_id");

-- AddForeignKey
ALTER TABLE "github_installation" ADD CONSTRAINT "github_installation_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_repo" ADD CONSTRAINT "github_repo_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────── THE BACKFILL ───────────────────────────────────
--
-- Each row's organisation is resolved THROUGH its workspace. `workspace.organization_id`
-- is NOT NULL, so the join is total for every row that has a workspace — which is
-- every `github_repo` row (`workspace_id` is NOT NULL there) and every
-- `github_installation` row except one shape.
--
-- ⚠️ THAT ONE SHAPE IS NOT A GAP: Motir's SHARED PROVISIONING INSTALLATION carries
-- `workspace_id IS NULL` by design (MOTIR-1931) — every tenant's Motir-created
-- repositories sit behind ONE installation, so it can name neither a workspace nor
-- an organisation, and the repository rows carry the tenancy instead. Its
-- `organization_id` stays NULL, and that is the honest value. The card's
-- "zero rows null" assertion is therefore scoped to rows that HAVE a workspace,
-- which is what the accompanying test asserts.
--
-- Idempotent (`WHERE organization_id IS NULL`), so a re-run — or a row written by
-- the old build after this ran — is picked up rather than clobbered.

-- ⚠️ `workspace."organizationId"` IS QUOTED CAMEL-CASE, not `organization_id`.
-- `Workspace.organizationId` carries no `@map`, so Prisma named the column after
-- the field — unlike almost every other column in this schema. Writing the
-- snake_case form here fails with `column w.organization_id does not exist`,
-- which is a migration that half-applies: the DDL above lands and the backfill
-- does not.

UPDATE "github_repo" AS r
   SET "organization_id" = w."organizationId"
  FROM "workspace" AS w
 WHERE w."id" = r."workspace_id"
   AND r."organization_id" IS NULL;

UPDATE "github_installation" AS i
   SET "organization_id" = w."organizationId"
  FROM "workspace" AS w
 WHERE w."id" = i."workspace_id"
   AND i."organization_id" IS NULL;
