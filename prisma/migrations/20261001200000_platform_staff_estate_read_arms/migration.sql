-- ===========================================================================
-- The ESTATE READ ARMS — `platform_staff` SELECT policies on the four tenant
-- tables below the organization (Story MOTIR-727 · Subtask MOTIR-730).
--
-- ---------------------------------------------------------------------------
-- 1. WHY THESE FOUR, AND WHY NOW
-- ---------------------------------------------------------------------------
-- `docs/decisions/platform-staff-auth.md`'s "deliberately does NOT decide"
-- table gives MOTIR-730 *"which tables get a `platform_staff` READ arm, and each
-- policy's SQL"*. `organization` was carved out on the record and shipped by
-- `20260905120000_organization_internal_billing`; this migration takes the
-- tiers beneath it — the estate's own hierarchy:
--
--   workspace                — the tier the overview counts and the drill-down lists
--   project                  — the tier below it
--   workspace_membership     — who is in a workspace (the drill-down's members)
--   organization_membership  — who is in an org (the same, one tier up)
--
-- Every one runs FORCE ROW LEVEL SECURITY and, before this file, not one of its
-- policies mentions `app.platform_staff`. Inside `withPlatformRead` a read of
-- any of them therefore returned ZERO ROWS AND RAISED NOTHING — an estate with
-- organizations and no workspaces, which a count reads as a fact rather than a
-- denial (the MOTIR-2880 silent-narrowing shape).
--
-- The ADR's §3a list also names `work_item`, `sprint` and `comment`. No read in
-- Story 10.1 reaches those (the overview counts tenants, not their work; the
-- drill-down's usage and jobs come over the 7.1 boundary from motir-ai), so
-- arming them now would widen the console's reach for no reader. They gain an
-- arm with the first card that reads them.
--
-- ---------------------------------------------------------------------------
-- 2. THE SHAPE — copied, not invented
-- ---------------------------------------------------------------------------
-- The predicate is `organization_platform_staff_read`'s verbatim:
-- `coalesce(current_setting('app.platform_staff', true), '') = 'true'`, so an
-- unbound GUC is `''` rather than NULL. It names no row column and no subquery,
-- so it costs a constant per row rather than a nested policy evaluation (the
-- per-row-tax lesson MOTIR-4669 measured).
--
-- ⚠️ `app.platform_staff`, NEVER the system-admin GUC — the ADR's §3a decisive
-- reason: that one is what the job runtime binds, and arming a tenant table for
-- it on the console's behalf would widen the JOB RUNTIME's reach too.
--
-- ⚠️ SELECT ONLY. The ADR's §3a is explicit that *"no INSERT / UPDATE / DELETE
-- policy on any tenant table gains a `platform_staff` arm"*; a governance write
-- (Story 10.3) opens the ordinary tenant context of the one tenant it names.
--
-- ⚠️ NO TENANT-SCOPED POLICY IS ALTERED. These are additional PERMISSIVE arms,
-- OR-ed with what each table already has; nothing that admits a tenant request
-- today changes, and a request that never binds `app.platform_staff` (every
-- request outside `withPlatformRead`) sees exactly what it saw before.
-- ===========================================================================

CREATE POLICY "workspace_platform_staff_read" ON "workspace"
  FOR SELECT
  USING (coalesce(current_setting('app.platform_staff', true), '') = 'true');

CREATE POLICY "project_platform_staff_read" ON "project"
  FOR SELECT
  USING (coalesce(current_setting('app.platform_staff', true), '') = 'true');

CREATE POLICY "workspace_membership_platform_staff_read" ON "workspace_membership"
  FOR SELECT
  USING (coalesce(current_setting('app.platform_staff', true), '') = 'true');

CREATE POLICY "organization_membership_platform_staff_read" ON "organization_membership"
  FOR SELECT
  USING (coalesce(current_setting('app.platform_staff', true), '') = 'true');
