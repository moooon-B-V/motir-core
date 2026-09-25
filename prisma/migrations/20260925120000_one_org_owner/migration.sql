-- MOTIR-6307 — exactly one Owner per organization (`docs/decisions/role-model.md`
-- §1, MOTIR-6165: "Owner: the root user, exactly one per organization").
--
-- Two halves, in ONE `DO` block so the file is a single statement (the migration
-- test replays it verbatim through one `$executeRawUnsafe`):
--
--   1. CONSOLIDATE. Every organization with more than one `owner` membership keeps
--      the EARLIEST (createdAt, then id) as `owner`; every other owner becomes
--      `admin`. The earliest-joined owner is the founder by construction of the
--      create path (`workspacesService.createWorkspace` writes the founder's owner
--      row first). An organization with NO owner (which the org-tier backfill,
--      20260613120000, should have prevented) gets its earliest member promoted,
--      mirroring that backfill. One `RAISE NOTICE` per organization changed, naming
--      the organization and the demoted / promoted membership ids — the deploy log
--      is the report.
--   2. HOLD THE INVARIANT. A partial unique index: at most one `role = 'owner'` row
--      per organization. On ("organizationId", "role"), NOT ("organizationId")
--      alone — `OrganizationMembership` already has `@@index([organizationId])`,
--      and a hand-written partial index reusing that column list makes
--      `prisma migrate diff` report a permanent spurious RENAME (motir-core
--      CLAUDE.md § Migrations). "At least one" stays the service's to hold; an
--      index can only say "at most one".
--
-- IDEMPOTENT: a second run finds exactly one owner everywhere and changes nothing,
-- and the index is `IF NOT EXISTS`.
--
-- RLS: `organization_membership` is FORCE ROW LEVEL SECURITY with no system arm;
-- this runs as the migration role, the BYPASSRLS owner, as every data migration
-- in this directory does.
--
-- ⚠️ THE DEPLOY WINDOW: the migration runs before the new code serves. For those
-- seconds, old code that promotes a member to `owner` meets this index and fails
-- with a unique violation. That is a refusal, not corruption, and it is accepted
-- rather than split into expand/contract.
DO $$
DECLARE
  org RECORD;
  keeper TEXT;
  demoted TEXT[];
BEGIN
  -- 1a. Organizations with more than one owner.
  FOR org IN
    SELECT "organizationId" AS id
      FROM "organization_membership"
     WHERE "role" = 'owner'
     GROUP BY "organizationId"
    HAVING count(*) > 1
     ORDER BY "organizationId"
  LOOP
    SELECT "id" INTO keeper
      FROM "organization_membership"
     WHERE "organizationId" = org.id AND "role" = 'owner'
     ORDER BY "createdAt", "id"
     LIMIT 1;

    WITH changed AS (
      UPDATE "organization_membership"
         SET "role" = 'admin', "updatedAt" = now()
       WHERE "organizationId" = org.id AND "role" = 'owner' AND "id" <> keeper
      RETURNING "id"
    )
    SELECT array_agg("id" ORDER BY "id") INTO demoted FROM changed;

    RAISE NOTICE 'MOTIR-6307 organization %: kept owner membership %, demoted to admin: %',
      org.id, keeper, demoted;
  END LOOP;

  -- 1b. Organizations with members but no owner.
  FOR org IN
    SELECT m."organizationId" AS id
      FROM "organization_membership" m
     GROUP BY m."organizationId"
    HAVING count(*) FILTER (WHERE m."role" = 'owner') = 0
     ORDER BY m."organizationId"
  LOOP
    SELECT "id" INTO keeper
      FROM "organization_membership"
     WHERE "organizationId" = org.id
     ORDER BY "createdAt", "id"
     LIMIT 1;

    UPDATE "organization_membership"
       SET "role" = 'owner', "updatedAt" = now()
     WHERE "id" = keeper;

    RAISE NOTICE 'MOTIR-6307 organization %: had no owner, promoted membership % to owner',
      org.id, keeper;
  END LOOP;

  -- 2. The invariant.
  CREATE UNIQUE INDEX IF NOT EXISTS "organization_membership_one_owner_key"
    ON "organization_membership" ("organizationId", "role")
    WHERE "role" = 'owner';
END $$;
