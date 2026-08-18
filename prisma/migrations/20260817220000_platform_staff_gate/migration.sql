-- ===========================================================================
-- The platform-staff gate FOUNDATION (MOTIR-2896) — the `platform_role` column,
-- the `platform_audit_log` table, and the one policy that governs it.
--
-- Implements `docs/decisions/platform-staff-auth.md` §§1 and 3b (MOTIR-729).
-- ONE migration for both halves, deliberately: the audit table's `actor_role`
-- column is of the enum this migration creates, so they cannot be split without
-- an ordering constraint between two files that has no reason to exist.
--
-- ---------------------------------------------------------------------------
-- WHAT `platform_role` IS, AND WHAT IT IS NOT
-- ---------------------------------------------------------------------------
-- NULL for every row this migration touches and for every row the product
-- creates. It is standing OUTSIDE all tenants — orthogonal to `member_role`
-- (6.4) and `organization_role` (6.10), and reachable from neither. There is no
-- backfill because there is no tenant role that maps onto it; the ADR's §1
-- invariant is precisely that no such mapping exists.
--
-- The column lands on `user`, which is one of the tables in
-- `tenant-root-creation-rls.test.ts`'s DELIBERATELY_UNGUARDED map ("the global
-- identity; users are not workspace-scoped"). That is unchanged by this
-- migration and is why the gate is an APPLICATION check (§2): there is no RLS
-- on `user` to lean on, and `docs/decisions/platform-staff-auth.md`'s
-- "RLS is the structural backstop, never the gate" says so in as many words.
--
-- ---------------------------------------------------------------------------
-- WHY `platform_audit_log` HAS A POLICY AND NOT AN EXEMPTION
-- ---------------------------------------------------------------------------
-- `tenant-root-creation-rls.test.ts` asserts an either/or over every table: it
-- is RLS-enabled with all four verbs covered by PERMISSIVE policies, or it is
-- named in DELIBERATELY_UNGUARDED with its justification. This table takes the
-- first branch, and the branch matters — under the non-bypass `motir_app` role
-- "RLS enabled, no policy" is a CLOSED DOOR, not an open one (notes.html #248,
-- the `add_workspace_rls` lesson). A table created with `ENABLE ROW LEVEL
-- SECURITY` and no policy would make every audit append fail silently at
-- exactly the moment MOTIR-2435's cutover lands, which is the one moment
-- nobody would be looking at this file.
--
-- FOR ALL, not four verb-specific policies, for the same reason: the totality
-- guard requires every verb to be covered. That the policy admits UPDATE and
-- DELETE *under a platform context* is not a claim that rows can be edited in
-- practice — append-only is an APPLICATION property here, enforced by
-- `platformAuditLogRepository` exposing `create` and reads and no mutator.
-- Tamper-EVIDENCE (the hash chain) is MOTIR-751's and is deliberately absent.
--
-- NO TENANT ARM AT ALL. No value of `app.workspace_id`, `app.organization_id`
-- or `app.user_id` admits a row: a tenant request cannot read the platform
-- audit log even by accident, and that is the whole point of the table. The
-- only key is `app.platform_staff`, the GUC `withPlatformRead`
-- (`lib/platform/context.ts`) binds and nothing else in the tree sets.
--
-- AND NOT `app.system_admin`, which would have been one line shorter. The ADR's
-- §3 argues it at length; the decisive half is that arming this table for
-- `system_admin` would hand the job runtime, the webhook paths and the meters
-- sight of the operator audit trail, because `withSystemContext` is what they
-- already bind. A separate GUC keeps the console's reach visible to the console
-- and to nothing else.
--
-- The `coalesce(current_setting(…, true), '')` form is deliberate: an UNBOUND
-- reader gets NULL from `current_setting`, `NULL = 'true'` is NULL, and a NULL
-- USING clause refuses the row — the coalesce only makes that explicit to the
-- next reader rather than changing it.
--
-- The workspace RLS migration's `ALTER DEFAULT PRIVILEGES … TO motir_app`
-- auto-grants on every NEW table created by the owner role, so no explicit
-- GRANT is needed (same as ci_container_usage / import / plan / sprint).
-- ===========================================================================

-- CreateEnum
CREATE TYPE "platform_role" AS ENUM ('support', 'operator', 'superadmin');

-- CreateEnum
CREATE TYPE "platform_audit_target_kind" AS ENUM ('organization', 'workspace', 'project', 'user', 'platform');

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "platform_role" "platform_role";

-- CreateTable
CREATE TABLE "platform_audit_log" (
    "id" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "actor_role" "platform_role" NOT NULL,
    "action" TEXT NOT NULL,
    "target_kind" "platform_audit_target_kind" NOT NULL,
    "target_id" TEXT,
    "target_label" TEXT,
    "organization_id" TEXT,
    "reason" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_audit_log_organization_id_created_at_idx" ON "platform_audit_log"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "platform_audit_log_actor_user_id_created_at_idx" ON "platform_audit_log"("actor_user_id", "created_at");

-- AddForeignKey
ALTER TABLE "platform_audit_log" ADD CONSTRAINT "platform_audit_log_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security — platform_audit_log
-- ---------------------------------------------------------------------------
ALTER TABLE "platform_audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_audit_log" FORCE ROW LEVEL SECURITY;

CREATE POLICY "platform_audit_log_platform_only" ON "platform_audit_log"
  FOR ALL
  USING      (coalesce(current_setting('app.platform_staff', true), '') = 'true')
  WITH CHECK (coalesce(current_setting('app.platform_staff', true), '') = 'true');
