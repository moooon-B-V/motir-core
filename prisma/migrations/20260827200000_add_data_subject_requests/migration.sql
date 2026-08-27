-- Data-subject requests — account erasure (Art. 17) and personal-data export
-- (Art. 15 + Art. 20). Story 8.4 · Subtask MOTIR-3698. Design of record:
-- `design/settings/design-notes.md` → `Data & privacy` (DECISIONs 1, 2 and 4).
--
-- ADDITIVE AND SAFE ON EXISTING DATA. Two new tables and two new enum types;
-- nothing existing is altered, no column is added to `user`, and both tables
-- start empty. Nothing reads them until somebody asks for their data.
--
-- ── THE PARTIAL UNIQUE INDEX IS THE REAL GUARD, NOT THE LOCK ────────────────
-- "At most one OPEN account-deletion request per user" is enforced HERE, in the
-- database, and deliberately not in application code. Scheduling is a
-- check-then-write, and `SELECT … FOR UPDATE` serialises concurrent writers only
-- when the row it names ALREADY EXISTS: over a predicate matching ZERO rows it
-- locks nothing, so two concurrent requests both read "no open request" and both
-- insert. The index is therefore what stops the FIRST race and the row lock is
-- what stops every subsequent one, which is the opposite of the intuitive
-- reading and is why it is written down here.
--
-- The consequence for the service that lands on top of this (MOTIR-3700): the
-- index raises a raw Prisma `P2002`, not a domain error, and untranslated that
-- reaches the caller as an unexplained 500 on every transport. Catch it OUTSIDE
-- the transaction (which is already aborted inside) and rethrow the SAME typed
-- error the in-transaction lock raises, so one condition has one outcome however
-- the race was lost.
--
-- `WHERE status = 'scheduled'` is what makes it partial: `cancelled` and
-- `completed` are terminal history and a person may hold any number of them.
--
-- ⚠️ Its column list `(user_id)` is NOT shared with any `@@index` on the same
-- model, and must not become so. Prisma's differ pairs a database index to a
-- datamodel index BY COLUMN LIST and cannot express a `WHERE` clause, so an
-- `@@index([userId])` beside this one would be paired with it, leaving the NAME
-- as the only difference and reporting a permanent spurious RENAME that the next
-- `migrate dev` writes into a migration — renaming one index over the other and
-- destroying it (`CLAUDE.md`, the partial-index rule; MOTIR-1960). The history
-- read is indexed on `(user_id, requested_at)` instead, which earns its second
-- column from its own `ORDER BY`.
--
-- ── ROW-LEVEL SECURITY — the `api_token` / `legal_acceptance` shape ─────────
-- Both tables are IDENTITY-scoped, not workspace-scoped, so the gate keys on the
-- `app.user_id` GUC rather than `app.workspace_id`: a data-subject request is
-- about a PERSON, exists whether or not they belong to any workspace, and would
-- have no honest value to put in a `workspace_id` column. That is the
-- `api_token` (7.8.1) and `legal_acceptance` (MOTIR-1135) precedent, not the
-- sprint / sprint_report_entry workspace-RLS contract.
--
-- These tables are NOT the `two_factor` / `passkey` / `device_code` case, which
-- ship with no RLS at all: those are read PRE-AUTH, before a session exists, so a
-- policy would hide the row from its only legitimate reader. Everything that
-- touches these two runs signed in, under `withUserContext`, or under
-- `withSystemContext` — so a policy has a GUC to consult in every path, and the
-- rows are exactly the kind of personal data that must not be readable across
-- accounts.
--
-- THE `system_admin` ARM IS FOR THE TWO BACKGROUND JOBS, and it is on BOTH
-- `USING` and `WITH CHECK` because both of them WRITE:
--   * the erasure sweep (MOTIR-3702) reads every `scheduled` request whose
--     `erasure_due_at` has passed — across all users, with nobody signed in —
--     and marks each `completed`;
--   * the export build (MOTIR-3701) picks up a `preparing` row, writes the
--     archive, and stamps `blob_pathname` / `built_at` / `expires_at`; its
--     expiry sweep later marks a row `expired`.
-- This is the `api_token_owner_or_system` shape exactly (whose system arm
-- likewise covers the throttled `last_used_at` touch), not the tenant-root write
-- policies that REFUSE `withSystemContext` (MOTIR-2865) — those refuse a system
-- arm because a tenant root must never be created without a member; here the
-- system caller is the product's own sweep acting on rows it has no other way to
-- reach.
--
-- ⚠️ ONE `FOR ALL` POLICY, WITH THE SAME PREDICATE ON BOTH SIDES, AND THAT IS
-- LOAD-BEARING RATHER THAN TIDY. Postgres applies the UPDATE policy's `USING`
-- to a `SELECT … FOR UPDATE` (locking a row for update implies update
-- permission) and filters non-qualifying rows out SILENTLY — no error. A table
-- whose read arm fires for a caller and whose update arm does not therefore
-- returns rows to a plain read and ZERO rows to the same read with `FOR UPDATE`,
-- which makes a lock helper inert while every signal says it works (MOTIR-3707 /
-- MOTIR-3710, measured on `organization`). Splitting these into a `FOR SELECT`
-- policy and a narrower `FOR UPDATE` one would reintroduce exactly that.
--
-- `current_setting(…, true)` is missing_ok, so an unset GUC yields NULL, the
-- predicate is NULL, and the row is hidden — no context means nothing visible,
-- which is the safe failure.
--
-- No explicit GRANT is needed: the tables are created by the `prodect` role,
-- which already owns the schema (the api_token / legal_acceptance precedent).

-- CreateEnum
CREATE TYPE "account_deletion_status" AS ENUM ('scheduled', 'cancelled', 'completed');

-- CreateEnum
CREATE TYPE "data_export_status" AS ENUM ('preparing', 'ready', 'failed', 'expired');

-- CreateTable
CREATE TABLE "account_deletion_request" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "erasure_due_at" TIMESTAMP(3) NOT NULL,
    "status" "account_deletion_status" NOT NULL DEFAULT 'scheduled',
    "cancelled_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_deletion_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_export_request" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "data_export_status" NOT NULL DEFAULT 'preparing',
    "blob_pathname" TEXT,
    "built_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "data_export_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "account_deletion_request_user_id_requested_at_idx" ON "account_deletion_request"("user_id", "requested_at");

-- CreateIndex
CREATE INDEX "account_deletion_request_status_erasure_due_at_idx" ON "account_deletion_request"("status", "erasure_due_at");

-- CreateIndex
CREATE INDEX "data_export_request_user_id_requested_at_idx" ON "data_export_request"("user_id", "requested_at");

-- CreateIndex
CREATE INDEX "data_export_request_status_expires_at_idx" ON "data_export_request"("status", "expires_at");

-- AddForeignKey
ALTER TABLE "account_deletion_request" ADD CONSTRAINT "account_deletion_request_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_export_request" ADD CONSTRAINT "data_export_request_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- CreateIndex
-- At most one OPEN (scheduled) erasure request per user — see the header block
-- for why this, and not a lock, is what makes scheduling race-safe.
CREATE UNIQUE INDEX "account_deletion_request_open_per_user_key"
  ON "account_deletion_request"("user_id")
  WHERE "status" = 'scheduled';

-- ===========================================================================
-- Row-level security — account_deletion_request + data_export_request
-- ===========================================================================
ALTER TABLE "account_deletion_request" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "account_deletion_request" FORCE ROW LEVEL SECURITY;

CREATE POLICY "account_deletion_request_owner_or_system" ON "account_deletion_request"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "user_id" = current_setting('app.user_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "user_id" = current_setting('app.user_id', true)
  );

ALTER TABLE "data_export_request" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "data_export_request" FORCE ROW LEVEL SECURITY;

CREATE POLICY "data_export_request_owner_or_system" ON "data_export_request"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "user_id" = current_setting('app.user_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "user_id" = current_setting('app.user_id', true)
  );
