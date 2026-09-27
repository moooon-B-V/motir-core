-- Workspace role NOT NULL — Release A of the legacy role storage's retirement
-- (Story MOTIR-6469 · Subtask MOTIR-6561).
--
-- MOTIR-6457 added `workspace_membership.workspace_role` NULLABLE, beside the
-- legacy `role`, so a row the still-serving pre-MOTIR-6168 build created during
-- its deploy window stayed correct: NULL meant "derive from `role`", and
-- `resolveWorkspaceRole` applied that fallback. MOTIR-6565 verified on
-- production (2026-09-26) that MOTIR-6168's release is serving and that no row
-- is NULL. This migration closes the window for good:
--
--   1. BACKFILL any straggler from the legacy column by the DECISION's table
--      (`docs/decisions/role-model.md`; the same mapping as
--      `20260926100100_workspace_role_mapping`): owner / admin → manager,
--      member → member, viewer → viewer. `role_definition_id` stays NULL — a
--      straggler never held a workspace custom role.
--   2. RAISE NOTICE the number backfilled (0 is the expected answer).
--   3. SET NOT NULL. Still NO default: every writer names the role, and a
--      default would hide one that forgot to.
--
-- ⚠️ WHY THIS IS SAFE UNDER THE PREVIOUS IMAGE. `release_command` migrates
-- before the new image takes traffic, so the constraint lands while the
-- MOTIR-6168 build still serves. That build has ONE writer of a membership
-- row — `workspaceMembershipRepository.create`, whose input type requires
-- `workspaceRole` — so it never inserts a NULL.
DO $$
DECLARE
  backfilled integer;
BEGIN
  UPDATE "workspace_membership"
     SET "workspace_role" = CASE "role"
       WHEN 'owner'  THEN 'manager'::"workspace_role"
       WHEN 'admin'  THEN 'manager'::"workspace_role"
       WHEN 'member' THEN 'member'::"workspace_role"
       WHEN 'viewer' THEN 'viewer'::"workspace_role"
     END
   WHERE "workspace_role" IS NULL;
  GET DIAGNOSTICS backfilled = ROW_COUNT;
  RAISE NOTICE 'MOTIR-6561: % workspace membership(s) backfilled from the legacy role', backfilled;
END $$;

-- AlterTable
ALTER TABLE "workspace_membership" ALTER COLUMN "workspace_role" SET NOT NULL;
