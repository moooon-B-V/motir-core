-- ===========================================================================
-- THE BOUNDARY MAILBOX (Story MOTIR-4054 · MOTIR-4067)
-- ===========================================================================
-- A planning job reads its envelope ONCE, at dispatch, so nothing a user types
-- while a run is working can reach it and there is nowhere to put a stop. This
-- is the storage half of the pipe.
--
-- ONE PIPE CARRIES BOTH, which is why this is one table and not a turns table
-- beside a `stopped` column. The consumer half already merged in `motir-ai`
-- (MOTIR-4060, `src/llm/mailbox.ts`) checks ONE mailbox at ONE phase boundary;
-- two pipes for one check is how a stop overtakes a turn typed before it, or a
-- turn is consumed after the run was told to end. Turns and the stop therefore
-- share a single `seq` sequence per job.
--
-- `job_id` is an OPAQUE motir-ai job token — a plain scalar, NOT an FK (the
-- `plan_change_session.last_job_id` precedent). The mailbox is per-RUN: a thread
-- that submits again starts an empty one.
--
-- Project-scoped tenant data, so the RLS policy lands in THIS SAME migration
-- (migration-by-concern — no unguarded window). Every FK is modelled as a Prisma
-- `@relation` on BOTH sides with the SAME actions this SQL uses, so
-- `migrate dev` reports "No difference detected" (the FK-`@relation` rule).
--
-- Two DB-level guarantees the app layer relies on rather than re-checking:
--   * `plan_change_mailbox_entry_session_id_job_id_seq_key` (UNIQUE) — mailbox
--     order is gapless and collision-free. The service allocates `seq` under a
--     `SELECT … FOR UPDATE` lock on the SESSION row + a re-read inside the
--     transaction (the lock-before-read-derived-update rule); this unique is the
--     backstop that turns a lost race into a typed error instead of two entries
--     claiming the same position. It is also why ordering does not rest on
--     `created_at`: two inserts inside the same millisecond is reachable, and it
--     is exactly the case a timestamp sort gets wrong.
--   * `plan_change_mailbox_entry_session_id_job_id_idempotency_key_key`
--     (UNIQUE) — a retried submit resolves to the row it already wrote rather
--     than delivering the same sentence twice.

-- CreateEnum
CREATE TYPE "plan_change_mailbox_kind" AS ENUM ('turn', 'stop');

-- CreateEnum
CREATE TYPE "plan_change_mailbox_disposition" AS ENUM ('fold', 'restart');

-- CreateTable
CREATE TABLE "plan_change_mailbox_entry" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "plan_change_mailbox_kind" NOT NULL,
    "body" TEXT,
    "disposition" "plan_change_mailbox_disposition",
    "restart_target" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "author_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_change_mailbox_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "plan_change_mailbox_entry_session_id_job_id_seq_idx" ON "plan_change_mailbox_entry"("session_id", "job_id", "seq");

-- CreateIndex
CREATE INDEX "plan_change_mailbox_entry_workspace_id_idx" ON "plan_change_mailbox_entry"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "plan_change_mailbox_entry_session_id_job_id_seq_key" ON "plan_change_mailbox_entry"("session_id", "job_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "plan_change_mailbox_entry_session_id_job_id_idempotency_key_key" ON "plan_change_mailbox_entry"("session_id", "job_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "plan_change_mailbox_entry" ADD CONSTRAINT "plan_change_mailbox_entry_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ⚠️ COMPOSITE FK, for the reason MOTIR-1735 gives on `plan_change_turn`: RLS
-- checks the row's own `workspace_id` and does NOT traverse foreign keys, so a
-- single-column FK would let a tenant plant an entry under a FOREIGN session —
-- passing `WITH CHECK` while claiming a `(session_id, job_id, seq)` slot the
-- victim can never use, wedging their run. Referencing the PAIR makes that row
-- nonexistent rather than merely invisible, and unlike a policy it also holds
-- for BYPASSRLS / superuser connections. `plan_change_session` already carries
-- the `(id, workspace_id)` unique that migration added.
-- AddForeignKey
ALTER TABLE "plan_change_mailbox_entry" ADD CONSTRAINT "plan_change_mailbox_entry_session_id_workspace_id_fkey" FOREIGN KEY ("session_id", "workspace_id") REFERENCES "plan_change_session"("id", "workspace_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_change_mailbox_entry" ADD CONSTRAINT "plan_change_mailbox_entry_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security — plan_change_mailbox_entry
-- ===========================================================================
-- The SAME single PERMISSIVE FOR ALL policy the rest of the tenant tables carry:
-- USING + WITH CHECK against current_setting('app.workspace_id', true) (`true` =
-- missing_ok, so an unset GUC yields NULL → predicate NULL → row hidden, the
-- safe failure). ENABLE + FORCE so even the table-owner role is subject to it
-- (production and the service writes connect as the non-BYPASSRLS app role). The
-- workspace RLS migration's `ALTER DEFAULT PRIVILEGES` auto-grants on every NEW
-- table, so no explicit GRANT is needed.
--
-- The policy is the READ isolation and the composite FK above is the layer
-- beneath it; a child table with no policy of its own is readable cross-tenant
-- by anyone who guesses a session id, and RLS does not traverse FKs.
ALTER TABLE "plan_change_mailbox_entry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plan_change_mailbox_entry" FORCE ROW LEVEL SECURITY;

CREATE POLICY "plan_change_mailbox_entry_active_workspace" ON "plan_change_mailbox_entry"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
