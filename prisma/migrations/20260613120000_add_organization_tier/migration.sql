-- The Organization (root-account) tenancy tier (Story 6.10 · Subtask 6.10.3).
-- Introduces the missing TOP tier above the workspace — `Organization` (the
-- account a customer is, the parent of N workspaces, and the billing entity
-- credits + usage roll up to) — plus `OrganizationMembership` (the org-tier
-- sibling of `workspace_membership`) and `Workspace.organizationId`, then
-- BACKFILLS every existing workspace into its own default org so no legacy data
-- is orphaned. Ships, in one atomic migration (migration-by-concern,
-- PRODECT_FINDINGS #20 — the tables and their RLS policies land together so
-- there is never an unguarded window):
--   1. enum `organization_role` (owner | admin | member — the org-scoped role,
--      DISTINCT from the 6.4 `member_role`);
--   2. `organization` + `organization_membership` tables, indexes, FKs;
--   3. `workspace.organizationId` added NULLABLE, then the data BACKFILL (one
--      default org per existing workspace, every existing workspace member
--      promoted to an org member, the workspace owner → org owner), then the
--      column made NON-nullable + its index + FK;
--   4. ENABLE + FORCE row-level security on both new tables with the SAME
--      tenant-root policy shape `workspace` / `workspace_membership` use (the
--      org tier is read ABOVE the workspace context — the switcher lists a
--      user's orgs before any org context is set — so the policies admit the
--      active-org GUC OR the user's own membership).
--
-- `Organization` is the NEW top tier — Better-Auth's `account` table (the
-- OAuth/credential auth-provider link) is NOT a tenancy tier and is left
-- untouched (see docs/decisions/organization-tier.md). The org-scoped services
-- + the access gate (org membership gates workspace access) + the signup
-- auto-provision are OUT of scope here (6.10.4) — this migration is the data
-- model + the backfill only.
--
-- Idempotency: the backfill acts ONLY on workspaces whose `organizationId` is
-- still NULL and the membership insert is `ON CONFLICT DO NOTHING`, so re-running
-- the backfill creates no duplicate orgs / memberships (the at-rest invariant the
-- 6.10.6 seed mirrors).

-- CreateEnum
CREATE TYPE "organization_role" AS ENUM ('owner', 'admin', 'member');

-- CreateTable
CREATE TABLE "organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_membership" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "organization_role" NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_membership_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organization_slug_key" ON "organization"("slug");

-- CreateIndex
CREATE INDEX "organization_membership_organizationId_idx" ON "organization_membership"("organizationId");

-- CreateIndex
CREATE INDEX "organization_membership_userId_idx" ON "organization_membership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "organization_membership_organizationId_userId_key" ON "organization_membership"("organizationId", "userId");

-- AddForeignKey
ALTER TABLE "organization_membership" ADD CONSTRAINT "organization_membership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_membership" ADD CONSTRAINT "organization_membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- workspace.organizationId — add NULLABLE, backfill, then enforce NOT NULL
-- ===========================================================================
-- The column is non-nullable in the final schema, but adding it NOT NULL to a
-- table with existing rows would fail (no default). So it lands nullable, the
-- backfill points every workspace at a freshly-created default org, and only
-- then is NOT NULL enforced. (Prisma's auto-diff proposed a bare
-- `ADD COLUMN ... NOT NULL`, which is why this is hand-curated.)
ALTER TABLE "workspace" ADD COLUMN "organizationId" TEXT;

-- Backfill step 1 — one default org per existing workspace (only those not yet
-- assigned, so a re-run is a no-op). The org reuses the workspace's globally-
-- unique `slug` (so `organization.slug` stays unique) and `name`; the workspace
-- is correlated to its new org by that shared slug in step 2.
INSERT INTO "organization" ("id", "name", "slug", "createdAt", "updatedAt")
SELECT
    gen_random_uuid()::text,
    w."name",
    w."slug",
    w."createdAt",
    CURRENT_TIMESTAMP
FROM "workspace" w
WHERE w."organizationId" IS NULL;

-- Backfill step 2 — point each workspace at its new org (matched on the shared
-- unique slug). After this every existing workspace has a non-null org.
UPDATE "workspace" w
SET "organizationId" = o."id"
FROM "organization" o
WHERE o."slug" = w."slug"
  AND w."organizationId" IS NULL;

-- Backfill step 3 — the UPWARD invariant for legacy rows: every existing
-- workspace member also becomes an org member (you cannot be in a workspace
-- without being in its org). The workspace OWNER maps to org `owner`; every
-- other workspace role maps to org `member` (an org owner/admin spans all
-- workspaces by role — 6.10.4 — so legacy non-owners default to plain member).
-- `ON CONFLICT DO NOTHING` makes it idempotent and dedupes.
INSERT INTO "organization_membership" ("id", "organizationId", "userId", "role", "createdAt", "updatedAt")
SELECT
    gen_random_uuid()::text,
    w."organizationId",
    wm."userId",
    (CASE WHEN wm."role" = 'owner' THEN 'owner' ELSE 'member' END)::"organization_role",
    wm."createdAt",
    CURRENT_TIMESTAMP
FROM "workspace_membership" wm
JOIN "workspace" w ON w."id" = wm."workspaceId"
WHERE w."organizationId" IS NOT NULL
ON CONFLICT ("organizationId", "userId") DO NOTHING;

-- Backfill step 4 — guarantee every backfilled org has an owner. Normally a
-- no-op (createWorkspace always founds an owner membership, 1.2.4), but a legacy
-- workspace with no `owner`-role member would otherwise leave its org ownerless;
-- promote that org's earliest-joined member to owner so the AC ("an owner
-- OrganizationMembership for each") holds unconditionally.
UPDATE "organization_membership" om
SET "role" = 'owner'
WHERE om."id" IN (
    SELECT DISTINCT ON (m."organizationId") m."id"
    FROM "organization_membership" m
    WHERE NOT EXISTS (
        SELECT 1 FROM "organization_membership" owner_m
        WHERE owner_m."organizationId" = m."organizationId"
          AND owner_m."role" = 'owner'
    )
    ORDER BY m."organizationId", m."createdAt" ASC, m."id" ASC
);

-- Now every workspace has an org → enforce NOT NULL, then index + FK.
ALTER TABLE "workspace" ALTER COLUMN "organizationId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "workspace_organizationId_idx" ON "workspace"("organizationId");

-- AddForeignKey
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security — organization + organization_membership
-- ===========================================================================
-- The org tier is a TENANT-ROOT pair, modelled exactly like
-- `workspace` / `workspace_membership` (add_workspace_rls), NOT like the pure
-- workspace-scoped tables: the org switcher reads a user's orgs ABOVE / BEFORE
-- any org context, so visibility is "the active-org GUC OR a row the user is a
-- member of". As with the workspace tables there is NO INSERT policy — INSERT
-- establishes a tenant (signup auto-provision in 6.10.4, the upward auto-join,
-- the seed) and is authorized at the application layer, before any org context
-- exists. The active-org GUC is `app.organization_id`, resolved by 6.10.4's
-- org-context layer; until then the membership disjunction covers every read.
--   * ENABLE + FORCE so even the table-owner role (`prodect`) is subject to it;
--     production connects as the non-bypass `prodect_app` role and the RLS tests
--     drop to it (PRODECT_FINDINGS #5).
--   * `current_setting('<key>', true)` — `true` is missing_ok, so an unset GUC
--     yields NULL → predicate NULL → row hidden (the safe failure mode).
--   * Grants: the add_workspace_rls ALTER DEFAULT PRIVILEGES already grants
--     SELECT/INSERT/UPDATE/DELETE on every NEW table the `prodect` role creates,
--     so no explicit GRANT is needed here (same as project_membership).
ALTER TABLE "organization" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization" FORCE ROW LEVEL SECURITY;

ALTER TABLE "organization_membership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_membership" FORCE ROW LEVEL SECURITY;

-- organization: the row whose id matches the active-org GUC is visible.
CREATE POLICY "organization_active" ON "organization"
  FOR SELECT
  USING ("id" = current_setting('app.organization_id', true));

-- organization: any org the user is a member of is visible (so the switcher can
-- list them all and the bootstrap path can resolve the active org from
-- membership). Multiple permissive SELECT policies are OR-combined.
CREATE POLICY "organization_membership_visible" ON "organization"
  FOR SELECT
  USING (
    "id" IN (
      SELECT "organizationId"
      FROM "organization_membership"
      WHERE "userId" = current_setting('app.user_id', true)
    )
  );

-- organization: UPDATE/DELETE require the active-org GUC to match the row
-- (membership alone does not authorize mutation — only operating in the org
-- context does; application-layer role checks (owner/admin) layer on top in
-- 6.10.4).
CREATE POLICY "organization_mutate_active" ON "organization"
  FOR UPDATE
  USING ("id" = current_setting('app.organization_id', true));

CREATE POLICY "organization_delete_active" ON "organization"
  FOR DELETE
  USING ("id" = current_setting('app.organization_id', true));

-- organization_membership: rows for the active org are visible, AND the user's
-- own membership rows are always visible (so the switcher / bootstrap path can
-- read memberships before any org_id is set) — the membership_visible_active_or_own
-- shape from workspace_membership.
CREATE POLICY "org_membership_visible_active_or_own" ON "organization_membership"
  FOR SELECT
  USING (
    "organizationId" = current_setting('app.organization_id', true)
    OR "userId" = current_setting('app.user_id', true)
  );

-- organization_membership: UPDATE requires the row to belong to the active org.
CREATE POLICY "org_membership_mutate_active" ON "organization_membership"
  FOR UPDATE
  USING ("organizationId" = current_setting('app.organization_id', true));

-- organization_membership: DELETE within the active org, OR a user removing
-- their own membership (the self-leave path).
CREATE POLICY "org_membership_delete_active_or_self" ON "organization_membership"
  FOR DELETE
  USING (
    "organizationId" = current_setting('app.organization_id', true)
    OR "userId" = current_setting('app.user_id', true)
  );
