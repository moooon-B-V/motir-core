-- MOTIR-6308 — an org Admin's reach inside a workspace now comes from
-- MEMBERSHIP (`docs/decisions/role-model.md` §1, reading R1). Until this story,
-- `organizationsService.resolveWorkspaceAccess` made every org owner OR admin a
-- workspace owner in EVERY workspace of the org, member or not. The code now
-- raises only the org Owner that way.
--
-- So that NO Admin loses anything today, this data migration writes the reach
-- they had as real rows: for every org Admin, and every workspace of their org
-- in which they hold no `workspace_membership`, it creates one with role
-- `admin` — the `MemberRole` today's effective-owner mapping made them
-- equivalent to (`isWorkspaceManager` treats `owner` and `admin` alike).
-- MOTIR-6168's migration later maps workspace `admin` → Manager, so these
-- Admins keep exactly today's reach. Only Admins made AFTER this migration
-- reach by membership alone.
--
-- ⚠️ ORDER-INDEPENDENT WITH MOTIR-6307's owner consolidation
-- (`20260925120000_*`), which demotes every owner but the earliest (by
-- `createdAt`, then `id`) to `admin`. Those demoted owners had the same reach
-- today, so they are covered here BY THE SAME RULE rather than by relying on
-- that migration having run first: a membership row counts as an Admin here
-- when its role is `admin`, OR when it is an `owner` that is not its org's
-- earliest owner. The org's one surviving Owner is never given a row — the
-- Owner reaches every workspace by role (MOTIR-6308's code), not by membership.
--
-- Idempotent: the NOT EXISTS makes a re-run insert nothing, and the
-- `(userId, workspaceId)` unique index backs it with ON CONFLICT DO NOTHING.
-- One RAISE NOTICE per row created, so the deploy log is the report.
DO $$
DECLARE
  r RECORD;
  created_count integer := 0;
BEGIN
  FOR r IN
    WITH surviving_owner AS (
      SELECT DISTINCT ON (om."organizationId") om."id"
      FROM "organization_membership" om
      WHERE om."role" = 'owner'
      ORDER BY om."organizationId", om."createdAt" ASC, om."id" ASC
    ),
    org_admins AS (
      SELECT om."organizationId", om."userId"
      FROM "organization_membership" om
      WHERE om."role" = 'admin'
         OR (om."role" = 'owner' AND om."id" NOT IN (SELECT "id" FROM surviving_owner))
    )
    INSERT INTO "workspace_membership" ("id", "userId", "workspaceId", "role", "createdAt", "updatedAt")
    SELECT gen_random_uuid()::text, a."userId", w."id", 'admin'::"member_role", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    FROM org_admins a
    JOIN "workspace" w ON w."organizationId" = a."organizationId"
    WHERE NOT EXISTS (
      SELECT 1 FROM "workspace_membership" wm
      WHERE wm."userId" = a."userId" AND wm."workspaceId" = w."id"
    )
    ON CONFLICT ("userId", "workspaceId") DO NOTHING
    RETURNING "id", "userId", "workspaceId"
  LOOP
    created_count := created_count + 1;
    RAISE NOTICE 'MOTIR-6308: org admin % kept whole in workspace % (workspace_membership %, role admin)',
      r."userId", r."workspaceId", r."id";
  END LOOP;
  RAISE NOTICE 'MOTIR-6308: % workspace membership(s) created for org admins', created_count;
END $$;
