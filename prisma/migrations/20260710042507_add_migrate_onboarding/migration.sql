-- The migrate-existing-codebase onboarding ("Workflow B") state-machine
-- substrate (Story 7.15 · MOTIR-1499, split from MOTIR-931). One durable,
-- RESUMABLE `migrate_onboarding` record per project; the wiring slice
-- (MOTIR-931) drives the per-step orchestration this scaffolding stands up.
--
-- Project-scoped tenant data, so its RLS policy lands in THIS SAME migration
-- (migration-by-concern, PRODECT_FINDINGS #20 — no unguarded window). Both FKs
-- are modelled as Prisma `@relation`s (forward + back-relation) with the SAME
-- actions the SQL uses, so `migrate dev` reports "No difference detected" (the
-- FK-`@relation` rule): workspace/project CASCADE (tenant + project teardown
-- take the onboarding run with them). `discovery_job_id` / `generate_job_id`
-- are OPAQUE motir-ai job tokens and `connected_repo_ref` an opaque repo ref —
-- plain scalars, NOT FKs (the `plan.source_job_id` precedent).
--
-- `migrate_onboarding_project_id_key` (UNIQUE) enforces ONE run per project at
-- the DB — the resumable single-run guarantee, not merely "the app checks
-- first".

-- CreateEnum
CREATE TYPE "migrate_onboarding_kind" AS ENUM ('migrate');

-- CreateEnum
CREATE TYPE "migrate_onboarding_step" AS ENUM ('connect', 'index', 'audit_convention', 'discovery', 'generate', 'review', 'done');

-- CreateEnum
CREATE TYPE "migrate_onboarding_status" AS ENUM ('active', 'completed', 'failed');

-- CreateTable
CREATE TABLE "migrate_onboarding" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "kind" "migrate_onboarding_kind" NOT NULL DEFAULT 'migrate',
    "step" "migrate_onboarding_step" NOT NULL DEFAULT 'connect',
    "status" "migrate_onboarding_status" NOT NULL DEFAULT 'active',
    "connected_repo_ref" TEXT,
    "code_graph_ready" BOOLEAN NOT NULL DEFAULT false,
    "convention_approved_at" TIMESTAMP(3),
    "discovery_job_id" TEXT,
    "generate_job_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "migrate_onboarding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "migrate_onboarding_workspace_id_idx" ON "migrate_onboarding"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "migrate_onboarding_project_id_key" ON "migrate_onboarding"("project_id");

-- AddForeignKey
ALTER TABLE "migrate_onboarding" ADD CONSTRAINT "migrate_onboarding_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "migrate_onboarding" ADD CONSTRAINT "migrate_onboarding_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security — migrate_onboarding (pure workspace gate, no escape hatch)
-- ===========================================================================
-- The SAME single PERMISSIVE FOR ALL policy as import / plan / sprint / comment:
-- USING + WITH CHECK against current_setting('app.workspace_id', true) (`true` =
-- missing_ok, so an unset GUC yields NULL → predicate NULL → row hidden, the safe
-- failure). ENABLE + FORCE so even the table-owner `prodect` role is subject to it
-- (production + the service writes connect as the non-BYPASSRLS `prodect_app`
-- role). The workspace RLS migration's `ALTER DEFAULT PRIVILEGES … TO prodect_app`
-- auto-grants on every NEW table created by the `prodect` role, so no explicit
-- GRANT is needed (same as import / plan / sprint / comment).
ALTER TABLE "migrate_onboarding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "migrate_onboarding" FORCE ROW LEVEL SECURITY;

CREATE POLICY "migrate_onboarding_active_workspace" ON "migrate_onboarding"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
