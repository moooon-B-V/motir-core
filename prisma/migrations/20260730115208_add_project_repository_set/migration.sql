-- The project's REPOSITORY SET (Story MOTIR-1775 · MOTIR-1780) — one row per
-- INTENDED repository, each with its own role, name, seed source and establish
-- state, specified by `docs/decisions/project-repository-set.md`.
--
-- This is also the project↔repo association whose absence
-- `lib/services/codeGraphIndexService.ts` and `lib/ai/codeContext.ts` each record
-- as a deferred refinement. This migration makes the association EXIST; neither
-- consumer is re-pointed here (that behaviour change belongs to MOTIR-1754).
--
-- Workspace-scoped tenant data, so its RLS policy lands in THIS SAME migration
-- (migration-by-concern, PRODECT_FINDINGS #20 — no unguarded window). All three
-- FKs are modelled as Prisma `@relation`s (forward + back-relation) with the SAME
-- actions the SQL uses, so `migrate dev` reports "No difference detected" (the
-- FK-`@relation` rule).
--
-- The two UNIQUE indexes are the two real corruptions this table must make
-- impossible, both enforced in the DATABASE and not merely "the app checks first":
--
--   * `project_repository_project_id_name_key` — at most ONE row per
--     `(project_id, name)`, so two rows can never race for one repo name. The
--     service additionally rejects a CASE-VARIANT collision (git-host repo names
--     are case-insensitive); this exact-match index is that guard's backstop and
--     the arbiter of a lost race.
--   * `project_repository_github_repo_id_key` — a realized `github_repo` row is
--     claimed by AT MOST ONE project row, so a repo created for project A can
--     never be recorded as project B's. Postgres permits many NULLs in a unique
--     index, which is exactly the semantics wanted: every `proposed` row is
--     unrealized.
--
-- `github_repo_id` is SET NULL on delete, deliberately NOT cascade: disconnecting
-- a repository must leave the set row with a null realized repo rather than
-- deleting it — a disconnected repo is not a lost plan (the role + name + seed
-- source survive, so the row can be re-established).
--
-- The two `project` columns are SET-level, not per-row, per ADR §3.5: a set is
-- never half in the user's account and half in Motir's, so the ownership + target
-- account are one choice for the whole set. Both nullable — every existing project
-- backfills to NULL with no data step.

-- CreateEnum
CREATE TYPE "project_repo_role" AS ENUM ('web', 'api', 'mobile', 'shared', 'infra', 'other');

-- CreateEnum
CREATE TYPE "project_repo_state" AS ENUM ('proposed', 'creating', 'created', 'connected', 'skipped', 'failed');

-- CreateEnum
CREATE TYPE "project_repo_ownership" AS ENUM ('user', 'motir');

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "repo_set_ownership" "project_repo_ownership",
ADD COLUMN     "repo_set_target_account" TEXT;

-- CreateTable
CREATE TABLE "project_repository" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "role" "project_repo_role" NOT NULL,
    "label" TEXT,
    "name" TEXT NOT NULL,
    "seed_source" TEXT NOT NULL,
    "state" "project_repo_state" NOT NULL DEFAULT 'proposed',
    "failure_reason" TEXT,
    "github_repo_id" TEXT,
    "position" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_repository_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_repository_github_repo_id_key" ON "project_repository"("github_repo_id");

-- CreateIndex
CREATE INDEX "project_repository_workspace_id_idx" ON "project_repository"("workspace_id");

-- CreateIndex
CREATE INDEX "project_repository_project_id_idx" ON "project_repository"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_repository_project_id_name_key" ON "project_repository"("project_id", "name");

-- AddForeignKey
ALTER TABLE "project_repository" ADD CONSTRAINT "project_repository_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_repository" ADD CONSTRAINT "project_repository_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_repository" ADD CONSTRAINT "project_repository_github_repo_id_fkey" FOREIGN KEY ("github_repo_id") REFERENCES "github_repo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security — project_repository (pure workspace gate, no escape hatch)
-- ===========================================================================
-- The SAME single PERMISSIVE FOR ALL policy as migrate_onboarding / plan /
-- sprint / comment: USING + WITH CHECK against
-- current_setting('app.workspace_id', true) (`true` = missing_ok, so an unset GUC
-- yields NULL → predicate NULL → row hidden, the safe failure). ENABLE + FORCE so
-- even the table-owner `prodect` role is subject to it (production + the service
-- writes connect as the non-BYPASSRLS `prodect_app` role).
--
-- No system-admin escape, unlike `github_installation`: every write to this table
-- comes from a REQUEST path with an active workspace (the establish step, the
-- derivation, the creation primitive's `attachRealizedRepo` call), never from a
-- webhook with no tenant. Adding an escape nobody needs would only widen the
-- surface. Note the gate is the row's OWN `workspace_id`, not a join through
-- `project` — RLS does not traverse foreign keys.
--
-- The workspace RLS migration's `ALTER DEFAULT PRIVILEGES … TO prodect_app`
-- auto-grants on every NEW table created by the `prodect` role, so no explicit
-- GRANT is needed (same as migrate_onboarding / import / plan / sprint / comment).
ALTER TABLE "project_repository" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_repository" FORCE ROW LEVEL SECURITY;

CREATE POLICY "project_repository_active_workspace" ON "project_repository"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
