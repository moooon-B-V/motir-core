-- The content language of the bound workspace's organisation, readable by any
-- writer in that workspace (Story MOTIR-7731 · MOTIR-8097).
--
-- A work-text write with no explicit language records its organisation's
-- content language, read inside the write's own transaction. The `organization`
-- row is visible only to an org MEMBER (`organization_membership_visible`) or
-- under the active-org GUC — and some writers are neither. The Motir SYSTEM
-- principal (the AI work item writer) holds a workspace membership and no org
-- membership, so an INVOKER join through `organization` read nothing and the
-- writer recorded the fallback `en` in a `ko` organisation: a wrong value
-- presented as a real one, which the story forbids.
--
-- So this one function reads past the org row's SELECT policies — the reach
-- comes from the owner's BYPASSRLS attribute, the dependency
-- 20260817120000_link_workspace_trigger_security_definer writes down — and
-- returns ONE non-sensitive column, and only for the workspace the CALLER'S
-- transaction is already bound to (`app.workspace_id`). Binding a workspace
-- context requires the workspace's own RLS to admit the caller, so the function
-- answers nothing a writer could not already act in. Any other id reads NULL.

CREATE OR REPLACE FUNCTION app_workspace_content_language(target_workspace_id text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT o."content_language"
    FROM "workspace" w
    JOIN "organization" o ON o."id" = w."organizationId"
   WHERE w."id" = target_workspace_id
     AND w."id" = current_setting('app.workspace_id', true)
   LIMIT 1
$$;

COMMENT ON FUNCTION app_workspace_content_language(text) IS
  'MOTIR-8097: the content language of the bound workspace''s organisation; NULL for any workspace the transaction is not bound to.';
