-- MOTIR-8058 — provision the Motir SYSTEM PRINCIPAL in production.
--
-- Every service-bearer write from motir-ai (`POST /api/internal/ai/work-items`
-- and its `[key]` comments / attachments routes) resolves its reporter through
-- `resolveSystemPrincipal()` (`lib/ai/serviceAuth.ts`), which needs the `user`
-- `system@motir.internal` AND a `workspace_membership` for it. Until now the
-- only writer of either was the dev seed (`scripts/plan-seed/systemPrincipal.ts`),
-- so production had neither and every such write answered 500
-- `system_principal_not_provisioned`: no planning-failure bug was ever filed.
--
-- What it writes, mirroring `seedSystemPrincipal`:
--   1. the `user` row — `system@motir.internal`, named `Motir`, email verified,
--      and NO credential `account`, so there is no password to sign in with. An
--      existing row is renamed to `Motir` (`MOTIR_SYSTEM_USER_NAME`).
--   2. a `workspace_membership` (`workspace_role` `member`) in the workspace that
--      owns the meta project;
--   3. a `project_membership` on the meta project.
--   No `organization_membership`: the principal is infrastructure, so it stays
--   out of member management and seat counts, exactly as the seed leaves it.
--
-- PINNED BY ID, NOT BY KEY. The meta project is `cmqfb4d8q000e2d0i6n62otyc` in
-- production. A customer workspace can also hold a project keyed `MOTIR`, and
-- `resolveSystemPrincipal` takes the user's FIRST membership, so a key match
-- could enrol the principal in a customer's tenant. The workspace is derived
-- from the pinned project. Where that project does not exist (dev, test, CI,
-- preview, self-host) the block writes NOTHING — not even the user — and the
-- seed keeps provisioning there.
--
-- RLS: `project`, `workspace_membership` and `project_membership` are all FORCE
-- ROW LEVEL SECURITY. This block does not lean on the migration role being the
-- BYPASSRLS owner: it binds the GUCs the policies read, transaction-locally
-- (`set_config(…, true)`), before each statement that needs them —
-- `app.system_admin` for the project lookup (`project_workspace_or_system_read`'s
-- system arm), then `app.workspace_id` for the two inserts
-- (`membership_insert_active_or_bootstrap` and
-- `project_membership_active_workspace`). So it behaves the same under the owner
-- and under the non-bypass runtime role, and the integration test runs it as
-- both. `user` carries no RLS.
--
-- IDEMPOTENT: the user is an upsert on its unique email and both memberships are
-- `ON CONFLICT DO NOTHING` on their unique pairs, so a re-run changes nothing.
-- One `DO` block, so the file is a single statement (the test replays it
-- verbatim) and every `set_config` stays inside it. `RAISE NOTICE` lines make the
-- deploy log the report.
DO $$
DECLARE
  meta_project_id CONSTANT text := 'cmqfb4d8q000e2d0i6n62otyc';
  meta_workspace_id text;
  principal_id text;
  ws_rows integer;
  pj_rows integer;
BEGIN
  PERFORM set_config('app.system_admin', 'true', true);
  SELECT p."workspaceId" INTO meta_workspace_id
    FROM "project" p
   WHERE p."id" = meta_project_id;
  PERFORM set_config('app.system_admin', '', true);

  IF meta_workspace_id IS NULL THEN
    RAISE NOTICE 'MOTIR-8058: meta project % not present; system principal not provisioned here',
      meta_project_id;
    RETURN;
  END IF;

  INSERT INTO "user" ("id", "email", "name", "emailVerified", "createdAt", "updatedAt")
  VALUES (gen_random_uuid()::text, 'system@motir.internal', 'Motir', true,
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON CONFLICT ("email") DO UPDATE
    SET "name" = EXCLUDED."name",
        "emailVerified" = true,
        "updatedAt" = CURRENT_TIMESTAMP
  RETURNING "id" INTO principal_id;

  PERFORM set_config('app.workspace_id', meta_workspace_id, true);

  INSERT INTO "workspace_membership" ("id", "userId", "workspaceId", "workspace_role", "createdAt", "updatedAt")
  VALUES (gen_random_uuid()::text, principal_id, meta_workspace_id, 'member'::"workspace_role",
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON CONFLICT ("userId", "workspaceId") DO NOTHING;
  GET DIAGNOSTICS ws_rows = ROW_COUNT;

  INSERT INTO "project_membership" ("id", "workspace_id", "project_id", "user_id", "created_at", "updated_at")
  VALUES (gen_random_uuid()::text, meta_workspace_id, meta_project_id, principal_id,
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON CONFLICT ("user_id", "project_id") DO NOTHING;
  GET DIAGNOSTICS pj_rows = ROW_COUNT;

  PERFORM set_config('app.workspace_id', '', true);

  RAISE NOTICE 'MOTIR-8058: system principal % in workspace % (workspace memberships created: %, project memberships created: %)',
    principal_id, meta_workspace_id, ws_rows, pj_rows;
END $$;
