-- The §8 hostname reservation — Bug MOTIR-4366.
--
-- `docs/decisions/public-tenant-addresses.md` §8 decides that a public subdomain
-- is never released for another workspace to claim, and 20260903010000
-- implemented that with the `public_address_hostname_key` unique index alone:
-- "a retired label keeps its row, the row keeps the name". That holds for a
-- RENAME. It does not hold when the WORKSPACE goes away, because
-- `public_address_workspace_id_fkey` is ON DELETE CASCADE — so a workspace
-- delete frees the live subdomain AND every retained alias back into the global
-- namespace.
--
-- And it is not an operator curiosity. `accountErasureSweepService` routes a
-- sole-membership workspace through `workspacesService.deleteWorkspace` on a
-- scheduled job, discharging a GDPR erasure request: the release happened with
-- nobody deciding it, under a green log line.
--
-- ⚠️ THE AMENDMENT KEEPS THE CASCADE. The alternative — tombstoning the address
-- row by nulling its tenancy — was rejected on the erasure half: the retained
-- value would still be the literal hostname, which can itself be the personal
-- datum, and `workspace_id` is the RLS tenancy key that every policy on that
-- table compares against. This table holds a HASH of the hostname instead, so
-- the name is held for ever and the personal datum is not retained. See the
-- model's doc comment in `prisma/schema.prisma` and the amendment in §8.
--
-- No data step. Every workspace deleted before this migration has already
-- released its labels; there is no record of them left to reserve, which is the
-- defect stated as a migration limitation rather than papered over.

-- CreateTable
CREATE TABLE "public_hostname_reservation" (
    "id" TEXT NOT NULL,
    "hostname_hash" TEXT NOT NULL,
    "retired_from_workspace_id" TEXT NOT NULL,
    "retired_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "public_hostname_reservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- The reservation IS the index. A claim asks one question — "is this digest
-- present?" — and the unique makes the answering write idempotent: a resumed
-- erasure sweep re-runs the reserve and inserts nothing, with no count-then-write
-- in between. Same shape, and the same reason, as `public_address_hostname_key`
-- one table over.
CREATE UNIQUE INDEX "public_hostname_reservation_hostname_hash_key" ON "public_hostname_reservation"("hostname_hash");

-- ⚠️ NO FOREIGN KEY on "retired_from_workspace_id", DELIBERATELY, and it is the
-- single most important property of this table. The row exists BECAUSE the
-- workspace was deleted; a FK would cascade it away at exactly the moment it
-- becomes load-bearing, which is the defect this migration repairs. The same
-- absence, for the same reason, as `code_graph_offboarding`'s tenant coordinates
-- (`docs/decisions/code-graph-index-fleet.md` §14.5). It is therefore also not a
-- Prisma `@relation`, so `CLAUDE.md`'s FK-`@relation` rule has nothing to drift
-- against here: there is no constraint in the database and none in the datamodel.

-- ===========================================================================
-- Row-level security — public_hostname_reservation
-- ===========================================================================
-- THREE policies, and the split is what makes this table APPEND-ONLY for every
-- tenant caller. Postgres combines permissive policies as (p1 OR p2 OR ...) per
-- COMMAND, so naming the commands separately is how a table can be readable by
-- everyone, insertable only on your own behalf, and never updatable or deletable
-- except by the operator.
--
--   * ENABLE + FORCE so even the table-owner role is subject to it. Production
--     connects as the non-bypass `motir_app` role.
--   * Grants: the add_workspace_rls migration's ALTER DEFAULT PRIVILEGES already
--     covers every NEW table this role creates, so no explicit GRANT here.
ALTER TABLE "public_hostname_reservation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public_hostname_reservation" FORCE ROW LEVEL SECURITY;

-- READ: unconditional, and that is the point rather than a relaxation.
--
-- The namespace is GLOBAL — that is the whole reason this table exists — so the
-- question "is this name held?" has to be answerable by a workspace that is not
-- the one that held it. A tenancy predicate here would hide every reservation
-- from every caller that could act on one, which is the silent-zero failure
-- `public_address`'s own system-arm migration (20260903020000) describes: the
-- read succeeds, returns nothing, and the claim goes through.
--
-- There is nothing in a row to protect. The hostname is a one-way digest, and
-- `retired_from_workspace_id` names a workspace that no longer exists.
CREATE POLICY "public_hostname_reservation_read" ON "public_hostname_reservation"
  FOR SELECT
  USING (true);

-- INSERT: on your OWN behalf only.
--
-- The only writer is `workspacesService.deleteWorkspace`, inside the same
-- `withWorkspaceContext` transaction as the delete — so the GUC is bound to the
-- workspace being deleted and this clause is satisfied by construction. What it
-- buys is the negative: no bound tenant can reserve a name against somebody
-- else's workspace id, so the table cannot be used to squat the namespace under
-- a plausible-looking provenance.
CREATE POLICY "public_hostname_reservation_reserve" ON "public_hostname_reservation"
  FOR INSERT
  WITH CHECK ("retired_from_workspace_id" = current_setting('app.workspace_id', true));

-- SYSTEM: the operator arm, and the ONLY path that can ever remove a
-- reservation.
--
-- FOR ALL, so it also supplies the UPDATE and DELETE arms the table would
-- otherwise be missing entirely — `tests/tenant-root-creation-rls.test.ts`
-- requires every RLS-enabled table to carry a permissive policy for all four
-- commands, and here that requirement and the design agree: releasing a name is
-- a deliberate operator act with a person behind it, never something a request
-- path can do.
--
-- `app.system_admin` is a CROSS-TABLE, CROSS-TENANT flag `lib/workspaces/context.ts`
-- documents as belonging to the jobs runtime and operator tooling only, never a
-- request path fed user input.
CREATE POLICY "public_hostname_reservation_system" ON "public_hostname_reservation"
  FOR ALL
  USING (current_setting('app.system_admin', true) = 'true')
  WITH CHECK (current_setting('app.system_admin', true) = 'true');
