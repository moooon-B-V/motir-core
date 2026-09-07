-- THE ORG READ ARM FOR `project_repository` (Story MOTIR-4669 · MOTIR-4679).
--
-- `Used by N projects` asks a question the shipped policy set cannot answer: WHICH
-- PROJECTS, ACROSS THE ORGANISATION, hold this repository. A repository belongs to
-- the organisation now (MOTIR-4649) and its links legitimately span the org's
-- workspaces — but `project_repository` carries exactly one policy,
--
--   project_repository_active_workspace  FOR ALL
--     USING (workspace_id = current_setting('app.workspace_id', true))
--
-- and there is no system arm either. So an org-spanning read returns ZERO ROWS and
-- RAISES NOTHING: the count on every inventory row would read `Used by no project
-- yet`, the disconnect dialog would name nobody, and both would look like a quiet
-- product rather than a broken query. That is the MOTIR-2956 failure shape, one
-- table over.
--
-- ── What this adds, and what it deliberately does not ────────────────────────
--
-- ONE permissive `FOR SELECT` policy. Permissive policies OR-combine, so this
-- WIDENS READS ONLY and cannot touch INSERT/UPDATE/DELETE — the existing FOR ALL
-- policy keeps sole authority over every write, and a sibling workspace still
-- cannot delete or re-point a link. That split is the same one MOTIR-4677 made for
-- `github_repo`, and for the same reason: DELETE is authorised by `USING` alone, so
-- re-predicating the FOR ALL policy would have handed a sibling workspace a delete
-- it never had.
--
-- The predicate has TWO arms, mirroring `github_repo_org_read` exactly:
--
--   1. the row's project belongs to a workspace of the SAME ORGANISATION as the
--      caller's bound workspace — the ordinary in-app read, which needs no
--      `app.organization_id` at all and therefore keeps working for every existing
--      caller that binds only a workspace;
--   2. …or the caller has explicitly bound `app.organization_id` to that
--      organisation — the org-scoped surfaces (`listRepositoryUsage`, the org-level
--      disconnect) reached through `bindOrganizationContext`.
--
-- Both arms resolve the organisation through `workspace`, because
-- `project_repository` carries no `organization_id` of its own and should not: its
-- tenancy is the project's, and the project's is the workspace's. A denormalised
-- column here would be a third place for the same fact to disagree.

CREATE POLICY "project_repository_org_read" ON "project_repository"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
        FROM "workspace" caller, "workspace" owner
       WHERE caller."id" = current_setting('app.workspace_id', true)
         AND owner."id" = "project_repository"."workspace_id"
         AND caller."organizationId" = owner."organizationId"
    )
    OR EXISTS (
      SELECT 1
        FROM "workspace" owner
       WHERE owner."id" = "project_repository"."workspace_id"
         AND owner."organizationId" = current_setting('app.organization_id', true)
    )
  );
