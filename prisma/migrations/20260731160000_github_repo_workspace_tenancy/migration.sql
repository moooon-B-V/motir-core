-- ===========================================================================
-- The provisioning-org mirror becomes PER-WORKSPACE (MOTIR-1931)
--
-- Implements the 2026-07-31 amendment to
-- `docs/decisions/project-repository-set.md` ("the provisioning org's mirror is
-- PER-WORKSPACE, and tenancy moves onto the repo row"), shape (b).
--
-- The 2026-07-30 amendment put EVERY project's repositories in ONE Motir org,
-- behind ONE GitHub App installation. `github_installation.workspace_id` binds an
-- installation to exactly one workspace, so that shared installation could be
-- mirrored into exactly one tenant — and the next tenant's establish would
-- re-bind it, prune the first tenant's repos (`deleteExcept`), and hide them
-- (this table's RLS policy joined through the installation).
--
-- So tenancy moves to the row that actually varies:
--   * `github_repo` gains its OWN `workspace_id` + its own RLS predicate — the
--     same shape `project_repository` already uses one table over ("the gate is
--     the row's OWN workspace_id, not a join through").
--   * `github_installation.workspace_id` becomes NULLABLE. NULL means "Motir's
--     shared provisioning installation, owned by no tenant". `installation_id`
--     stays UNIQUE — one installation is still one row, so the token mint, the
--     GitLab `FOR UPDATE` refresh lock and the uninstall delete all keep
--     addressing exactly one row.
--
-- The nullable column is also the compile-time guard: every call site that read
-- `installation.workspaceId` as a `string` is now a `string | null` and had to be
-- swept (the ten sites the amendment enumerates).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · github_repo.workspace_id — add, BACKFILL, then constrain
--
-- Added nullable first and backfilled from the parent installation: every
-- EXISTING row belongs to a workspace's own installation (the shared one has
-- never held a repo — nothing has ever been created in the provisioning org yet,
-- which is the whole window this migration lands in), so the join is exact and
-- total. Only then does it become NOT NULL.
-- ---------------------------------------------------------------------------
ALTER TABLE "github_repo" ADD COLUMN "workspace_id" TEXT;

UPDATE "github_repo" r
SET "workspace_id" = i."workspace_id"
FROM "github_installation" i
WHERE i."id" = r."installation_id"
  AND i."workspace_id" IS NOT NULL;

-- A repo whose installation somehow has no workspace cannot be attributed, and a
-- NULL here would silently disable the RLS predicate for it. There are no such
-- rows at this migration (the column above is NOT NULL until step 2), so this is
-- a belt-and-braces guard rather than expected cleanup.
DELETE FROM "github_repo" WHERE "workspace_id" IS NULL;

ALTER TABLE "github_repo" ALTER COLUMN "workspace_id" SET NOT NULL;

CREATE INDEX "github_repo_workspace_id_idx" ON "github_repo"("workspace_id");

ALTER TABLE "github_repo"
  ADD CONSTRAINT "github_repo_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 2 · github_installation.workspace_id — nullable (the shared installation)
--
-- Done AFTER the backfill above, so the backfill runs while the column is still
-- guaranteed non-null.
-- ---------------------------------------------------------------------------
ALTER TABLE "github_installation" ALTER COLUMN "workspace_id" DROP NOT NULL;

-- ===========================================================================
-- 3 · Row-level security — github_repo now gates on its OWN workspace_id
--
-- Was: `EXISTS (SELECT 1 FROM github_installation i WHERE i.id =
-- github_repo.installation_id AND i.workspace_id = app.workspace_id)`. Under a
-- shared installation that predicate hides EVERY tenant's created repos from
-- everyone but the one workspace the installation happened to be bound to —
-- which is why a created repo never read as `established` and never reached
-- `toProjectRepoNames`.
--
-- The `app.system_admin` escape is KEPT: the webhook + the background index jobs
-- have no active workspace and read this table under `withSystemContext`, exactly
-- as `github_installation` does. (`project_repository` has no escape because
-- every one of ITS writes comes from a request path with an active workspace;
-- that is not true here.)
--
-- Note what happens to `github_installation`'s own policy with no change at all:
-- the shared row's `workspace_id` is NULL, so `NULL = current_setting(...)` is
-- NULL → the row is invisible to every tenant read and visible only under the
-- system escape. That is exactly the intended posture, and it is why this
-- migration does not touch that policy.
-- ===========================================================================
DROP POLICY "github_repo_workspace_or_system" ON "github_repo";

CREATE POLICY "github_repo_workspace_or_system" ON "github_repo"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  );

-- ===========================================================================
-- 4 · github_pull_request — one hop instead of two
--
-- Was: pr → repo → installation.workspace_id. Now the repo answers directly, so
-- the join through the installation disappears (and with it the same
-- shared-installation hole: a PR on a created repo was invisible to its own
-- tenant).
-- ===========================================================================
DROP POLICY "github_pull_request_workspace_or_system" ON "github_pull_request";

CREATE POLICY "github_pull_request_workspace_or_system" ON "github_pull_request"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "github_repo" r
      WHERE r."id" = "github_pull_request"."repo_id"
        AND r."workspace_id" = current_setting('app.workspace_id', true)
    )
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "github_repo" r
      WHERE r."id" = "github_pull_request"."repo_id"
        AND r."workspace_id" = current_setting('app.workspace_id', true)
    )
  );

-- ===========================================================================
-- 5 · github_check_run — the same two-hop join, one table further out
--
-- Was: check_run → pull_request → repo → installation.workspace_id
-- (20260703140000_add_ci_verification). Same rewrite: the repo row answers.
-- ===========================================================================
DROP POLICY "github_check_run_workspace_or_system" ON "github_check_run";

CREATE POLICY "github_check_run_workspace_or_system" ON "github_check_run"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "github_pull_request" p
      JOIN "github_repo" r ON r."id" = p."repo_id"
      WHERE p."id" = "github_check_run"."pull_request_id"
        AND r."workspace_id" = current_setting('app.workspace_id', true)
    )
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "github_pull_request" p
      JOIN "github_repo" r ON r."id" = p."repo_id"
      WHERE p."id" = "github_check_run"."pull_request_id"
        AND r."workspace_id" = current_setting('app.workspace_id', true)
    )
  );
