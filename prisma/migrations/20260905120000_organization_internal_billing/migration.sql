-- ===========================================================================
-- `Organization.internalBilling` + the `organization` PLATFORM-STAFF arms
-- (Story MOTIR-4337 · Subtask MOTIR-4565).
--
-- ---------------------------------------------------------------------------
-- 1. THE COLUMN — additive, and it FLIPS NO DATA
-- ---------------------------------------------------------------------------
-- `20260623000000_add_organization_is_meta` classified the live `moooon` row
-- with an `UPDATE ... WHERE slug = 'moooon'`. This migration deliberately does
-- NOT: classifying an org is an OPERATOR'S ACT through the control this story
-- ships, recorded with a reason in `platform_audit_log`, and that is the entire
-- point of the story. A migration that flipped the flag would classify the one
-- org nobody would ever have to ask about and leave the surface untested.
--
-- What the column MEANS is on the schema field's own comment and in
-- `docs/decisions/internal-billing-classification.md` §1: charged exactly like a
-- customer, then made whole by a paired offset. It is NOT `isMeta`, which keeps
-- its shipped meaning and gains no third one.
--
-- ---------------------------------------------------------------------------
-- 2. THE TWO ARMS — and why `organization` had none
-- ---------------------------------------------------------------------------
-- `organization` runs FORCE ROW LEVEL SECURITY. Its policy inventory before
-- this migration is eight: SELECT `organization_active`,
-- `organization_membership_visible`, `organization_visible_bootstrap`,
-- `organization_public_project_read`, `organization_system_read`; UPDATE
-- `organization_mutate_active`; DELETE `organization_delete_active`; INSERT
-- `organization_insert_bootstrap`. Not one of them mentions
-- `app.platform_staff`, and `lib/platform/context.ts` states the consequence in
-- as many words:
--
--     "no tenant table has gained a `platform_staff` policy arm … a tenant read
--      inside this context returns zero rows"
--
-- So without these arms the operator console cannot SEE an organization — not
-- "cannot write to one". A read returns ZERO ROWS and raises nothing, which the
-- caller then reads as "no such org" (the MOTIR-2880 silent-narrowing shape).
-- Both halves of MOTIR-4337's control are therefore blocked on this file.
--
-- ⚠️ `app.platform_staff`, NEVER the SYSTEM-ADMIN GUC. (Named in prose rather
-- than spelled out, so this card's own criterion 3 — a grep for that GUC over
-- this migration returning zero — stays a real check on the POLICIES rather than
-- a check on whether anybody mentioned it.) The ADR
-- (`docs/decisions/platform-staff-auth.md` §3a) is explicit: `withSystemContext`
-- is what the job ledger, the webhook paths and the meters already bind, so
-- arming a tenant table for `system_admin` on the console's behalf would
-- silently widen the JOB RUNTIME's reach over that table. `organization`
-- already carries `organization_system_read` for the ONE join that needed it
-- (`ciFleetCostMeterService`'s meta/tenant cost split); the console gets its own
-- key so that "what can read another tenant's org row?" keeps an answer
-- somebody can read in an afternoon.
--
-- ⚠️ CARVED FROM MOTIR-730 ON THE RECORD. That card owns "which tables get a
-- `platform_staff` policy arm, and each policy's SQL". This migration takes
-- `organization` and ONLY `organization`; MOTIR-730 keeps every other table's
-- arms and `platformReadService`, and is amended to say so
-- (`docs/decisions/internal-billing-classification.md` §5).
--
-- ⚠️ THE UPDATE ARM CARRIES BOTH `USING` AND `WITH CHECK`. `USING` decides which
-- rows the statement may SEE to update; `WITH CHECK` decides what the updated
-- row may look like. An UPDATE policy with only `USING` lets a platform write
-- produce a row the policy would not have admitted, which on the org row — the
-- one that carries billing state — is the difference between a gate and a
-- doorway. The `platform_audit_log` policy from
-- `20260817220000_platform_staff_gate` is the shape copied here, GUC form
-- included (`coalesce(current_setting(...), '')`, so an unbound GUC is `''`
-- rather than NULL).
--
-- ⚠️ NO WRITE VERB IS WIDENED BEYOND UPDATE. INSERT and DELETE on `organization`
-- are untouched: platform staff classify an existing org, they do not create or
-- destroy tenants. `20260817120000`'s note applies here with more force than it
-- did there — the org row carries billing state, so a widened verb would be a
-- billing-TAMPERING surface rather than a leak.
--
-- The four-verb totality guard (`tests/tenant-root-creation-rls.test.ts`) is
-- already satisfied by the eight policies above and is unaffected by two
-- additional permissive arms.
-- ===========================================================================

ALTER TABLE "organization"
  ADD COLUMN "internal_billing" BOOLEAN NOT NULL DEFAULT false;

-- The console's READ arm — what makes the org lookup and the org page return
-- rows at all inside `withPlatformRead`.
CREATE POLICY "organization_platform_staff_read" ON "organization"
  FOR SELECT
  USING (coalesce(current_setting('app.platform_staff', true), '') = 'true');

-- The console's UPDATE arm — the classification write, and nothing else on the
-- row is reachable from any service that binds this GUC.
CREATE POLICY "organization_platform_staff_update" ON "organization"
  FOR UPDATE
  USING      (coalesce(current_setting('app.platform_staff', true), '') = 'true')
  WITH CHECK (coalesce(current_setting('app.platform_staff', true), '') = 'true');
