-- Public addresses for a public project — Story MOTIR-3878 · Subtask MOTIR-4209.
--
-- `docs/decisions/public-tenant-addresses.md` is the record this implements:
-- §3 (a subdomain names a WORKSPACE), §4 (a customer domain names ONE project at
-- its root), §7 (exactly one primary), §8 (a retired subdomain is never
-- released).
--
-- Ships in ONE atomic migration (migration-by-concern): the enums, the table,
-- its indexes and FKs, the `project.primary_address_id` FK, AND its RLS policies
-- — so there is never a window in which the table exists unguarded.
--
-- No data step. Every existing project has zero addresses, and
-- `primary_address_id` is nullable with NULL meaning "the ADR §7 default rule
-- applies", so existing rows are already correct.

-- CreateEnum
CREATE TYPE "PublicAddressKind" AS ENUM ('workspace_subdomain', 'workspace_subdomain_alias', 'custom_domain');

-- CreateEnum
CREATE TYPE "PublicAddressStatus" AS ENUM ('active', 'alias', 'unverified', 'verifying', 'pending_certificate', 'issued', 'failed', 'expired', 'revoked');

-- CreateTable
CREATE TABLE "public_address" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT,
    "hostname" TEXT NOT NULL,
    "kind" "PublicAddressKind" NOT NULL,
    "status" "PublicAddressStatus" NOT NULL,
    "verification_token" TEXT,
    "last_checked_at" TIMESTAMP(3),
    "issued_at" TIMESTAMP(3),
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "public_address_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- GLOBAL, not per-workspace. A hostname resolves to exactly one owner on the
-- public internet, so two workspaces holding one name is an impossibility rather
-- than a tenancy question. This index is therefore both the correctness
-- constraint and the RACE ARBITER: two concurrent claims produce one winner and
-- one 23505, which the repository rethrows as a typed HostnameTakenError. It is
-- also what makes the ADR §8 never-released rule hold with no extra machinery —
-- a retired label keeps its row, the row keeps the name.
CREATE UNIQUE INDEX "public_address_hostname_key" ON "public_address"("hostname");

-- CreateIndex
CREATE INDEX "public_address_workspace_id_idx" ON "public_address"("workspace_id");

-- CreateIndex
CREATE INDEX "public_address_project_id_idx" ON "public_address"("project_id");

-- CreateIndex
-- The certificate-status job's sweep (MOTIR-4219): "every address in state X not
-- checked since T". Both columns, in that order — the job filters on the state
-- and orders on the clock, so a single-column index on `status` would leave the
-- sort to be done in memory over the whole state's population.
CREATE INDEX "public_address_status_last_checked_at_idx" ON "public_address"("status", "last_checked_at");

-- AlterTable
-- The ADR §7 canonical rule as a CONSTRAINT rather than a convention: one
-- nullable FK cannot point at two rows, so "exactly one primary address per
-- project" is unrepresentable-otherwise instead of enforced by a check somebody
-- has to remember to write. NULL means the default rule applies.
ALTER TABLE "project" ADD COLUMN "primary_address_id" TEXT;

-- CreateIndex
CREATE INDEX "project_primary_address_id_idx" ON "project"("primary_address_id");

-- AddForeignKey
ALTER TABLE "public_address" ADD CONSTRAINT "public_address_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public_address" ADD CONSTRAINT "public_address_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- SET NULL, not CASCADE: removing the address a project is canonical at must not
-- delete the PROJECT — it must fall back to the ADR §7 default. Cascading here
-- would make "remove this domain" delete the project it served, which is the
-- worst available reading of that button.
ALTER TABLE "project" ADD CONSTRAINT "project_primary_address_id_fkey" FOREIGN KEY ("primary_address_id") REFERENCES "public_address"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security — public_address
-- ===========================================================================
-- TWO policies, and the split is the same one `project` carries
-- (20260811230000_public_project_read_policy): a FOR ALL tenancy gate, plus a
-- FOR SELECT public arm. They are separate policies rather than one widened
-- clause for the reason that migration spells out — Postgres combines
-- permissive policies as (p1 OR p2 OR ...) PER COMMAND, so folding the public
-- arm into the FOR ALL policy's USING would widen UPDATE and DELETE too, and
-- DELETE has no WITH CHECK to catch it. A separate FOR SELECT policy widens
-- SELECT and only SELECT.
--
--   * ENABLE + FORCE so even the table-owner role is subject to it. FORCE does
--     not defeat BYPASSRLS on a superuser; production connects as the non-bypass
--     `motir_app` role.
--   * `current_setting('app.workspace_id', true)` — `true` is missing_ok, so an
--     unset GUC yields NULL, the predicate is NULL, and the row is hidden. The
--     safe failure mode.
--   * Grants: the add_workspace_rls migration's ALTER DEFAULT PRIVILEGES already
--     covers every NEW table this role creates, so no explicit GRANT here.
ALTER TABLE "public_address" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public_address" FORCE ROW LEVEL SECURITY;

-- The tenancy gate. A row is visible and mutable when its denormalized
-- `workspace_id` matches the active-workspace GUC. Every write path — claiming a
-- subdomain, renaming one, adding or removing a customer domain — runs inside an
-- active workspace context, so one FOR ALL policy covers all four commands, and
-- WITH CHECK blocks inserting or moving a row into a foreign workspace.
CREATE POLICY "public_address_active_workspace" ON "public_address"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

-- The ANONYMOUS public-read arm, and it is the reason this table needs a second
-- policy at all.
--
-- Host resolution (MOTIR-4217's `GET /api/public/hosts/{host}`) is the one read
-- that arrives with NO workspace bound: a visitor types `roadmap.acme.com` and
-- the whole question is which project that names. Binding the workspace first
-- would presume the answer, and `withSystemContext` is not available to a
-- request path fed user input — the same argument MOTIR-2684 made for `project`,
-- verbatim, one table over. So the honest fix is the same one: say in the RULE
-- what the product already says in the UI.
--
-- ⚠️ IT IS NARROWER THAN "any address", and the narrowing is the point. An
-- address is publicly readable only when what it POINTS AT is public:
--   * a `custom_domain` — when its own project is public;
--   * a `workspace_subdomain` / `..._alias` — when the workspace holds at least
--     one public project, which is exactly `workspace_public_project_read`'s
--     test (20260815200000) one table over.
-- A workspace with no public project leaks no subdomain, and a private project's
-- domain resolves to nothing for an anonymous reader. Both inner reads are
-- themselves subject to `project`'s own policies, including `project_public_read`,
-- which bottoms the chain out on a bare column test — so there is no recursion
-- for Postgres to refuse.
--
-- ⚠️ GATED ON AN UNSET `app.workspace_id`, so the arm opens only on the
-- context-less public connection and never widens an ordinary bound tenant read.
-- Same gate, same reason, as the `workspace` arm it mirrors.
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
            AND p."accessLevel" = 'public'
        )
        ELSE EXISTS (
          SELECT 1
          FROM "project" p
          WHERE p."workspaceId" = "public_address"."workspace_id"
            AND p."accessLevel" = 'public'
        )
      END
    )
  );
