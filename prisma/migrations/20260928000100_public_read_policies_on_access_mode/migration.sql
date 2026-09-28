-- The seven public-read policies key on the access MODE — Release 1 of the
-- retirement of `project."accessLevel"` (Story MOTIR-6554 · Subtask MOTIR-6687).
--
-- Every policy that lets a signed-out reader see a public project's rows decided
-- "is this project public?" from the legacy level, `"accessLevel" = 'public'`.
-- MOTIR-6686 made `access_mode` NOT NULL and checked that every row's two columns
-- agree, so the mode now answers the same question for every row. This migration
-- moves each of the seven onto it, and nothing else: each is DROPPED and
-- RE-CREATED with the SAME name, table, command, roles and expression as the
-- migration that last created it (named above each block), except that
-- `"accessLevel" = 'public'` becomes `"access_mode" = 'public'`. A re-create
-- rather than an ALTER, so each definition is readable whole here.
--
-- ⚠️ WHY THIS IS SAFE UNDER THE PREVIOUS IMAGE. `release_command` migrates while
-- the previous image still serves. Both columns agree on every row (MOTIR-6686's
-- agreement check), and that image's only access writer — `setAccessMode` —
-- writes both, so each policy admits exactly the rows it admitted before. The
-- application's own public queries move to the mode in the same release
-- (`projectRepository`, `projectTagRepository`), so the database and the
-- listings cannot disagree about what is public.
--
-- DROP and CREATE run in the one transaction `migrate deploy` gives this file,
-- so no reader ever sees a table without its public arm.

-- project_public_read — from 20260811230000_public_project_read_policy.
DROP POLICY "project_public_read" ON "project";
CREATE POLICY "project_public_read" ON "project"
  FOR SELECT
  USING ("access_mode" = 'public');

-- work_item_public_project_read — from 20260811230000_public_project_read_policy.
DROP POLICY "work_item_public_project_read" ON "work_item";
CREATE POLICY "work_item_public_project_read" ON "work_item"
  FOR SELECT
  USING (
    coalesce(current_setting('app.workspace_id', true), '') = ''
    AND EXISTS (
      SELECT 1
      FROM "project" p
      WHERE p."id" = "work_item"."projectId"
        AND p."access_mode" = 'public'
    )
  );

-- public_request_vote_public_project_read — from 20260813210000_public_request_vote_public_read.
DROP POLICY "public_request_vote_public_project_read" ON "public_request_vote";
CREATE POLICY "public_request_vote_public_project_read" ON "public_request_vote"
  FOR SELECT
  USING (
    coalesce(current_setting('app.workspace_id', true), '') = ''
    AND EXISTS (
      SELECT 1
      FROM "work_item" wi
      JOIN "project" p ON p."id" = wi."projectId"
      WHERE wi."id" = "public_request_vote"."work_item_id"
        AND p."access_mode" = 'public'
    )
  );

-- workflow_status_public_project_read — from 20260815200000_public_project_join_read_policies.
DROP POLICY "workflow_status_public_project_read" ON "workflow_status";
CREATE POLICY "workflow_status_public_project_read" ON "workflow_status"
  FOR SELECT
  USING (
    coalesce(current_setting('app.workspace_id', true), '') = ''
    AND EXISTS (
      SELECT 1
      FROM "project" p
      WHERE p."id" = "workflow_status"."project_id"
        AND p."access_mode" = 'public'
    )
  );

-- workspace_public_project_read — from 20260815200000_public_project_join_read_policies.
DROP POLICY "workspace_public_project_read" ON "workspace";
CREATE POLICY "workspace_public_project_read" ON "workspace"
  FOR SELECT
  USING (
    coalesce(current_setting('app.workspace_id', true), '') = ''
    AND EXISTS (
      SELECT 1
      FROM "project" p
      WHERE p."workspaceId" = "workspace"."id"
        AND p."access_mode" = 'public'
    )
  );

-- organization_public_project_read — from 20260815200000_public_project_join_read_policies.
DROP POLICY "organization_public_project_read" ON "organization";
CREATE POLICY "organization_public_project_read" ON "organization"
  FOR SELECT
  USING (
    coalesce(current_setting('app.workspace_id', true), '') = ''
    AND EXISTS (
      SELECT 1
      FROM "project" p
      JOIN "workspace" w ON w."id" = p."workspaceId"
      WHERE w."organizationId" = "organization"."id"
        AND p."access_mode" = 'public'
    )
  );

-- public_address_public_read — from 20260903010000_add_public_address.
DROP POLICY "public_address_public_read" ON "public_address";
CREATE POLICY "public_address_public_read" ON "public_address"
  FOR SELECT
  USING (
    coalesce(current_setting('app.workspace_id', true), '') = ''
    AND (
      CASE
        WHEN "project_id" IS NOT NULL THEN EXISTS (
          SELECT 1
          FROM "project" p
          WHERE p."id" = "public_address"."project_id"
            AND p."access_mode" = 'public'
        )
        ELSE EXISTS (
          SELECT 1
          FROM "project" p
          WHERE p."workspaceId" = "public_address"."workspace_id"
            AND p."access_mode" = 'public'
        )
      END
    )
  );
