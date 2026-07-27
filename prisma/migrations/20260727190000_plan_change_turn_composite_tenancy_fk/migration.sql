-- ===========================================================================
-- plan_change_turn — prove a turn's tenancy against its PARENT (MOTIR-1735)
-- ===========================================================================
-- Fixes a cross-tenant availability defect in the policies that shipped with
-- `20260727120000_add_plan_change_session`. That migration is already applied,
-- so this is a FORWARD-ONLY repair: never edit an applied migration (its
-- checksum is recorded in `_prisma_migrations`, and `migrate deploy` refuses a
-- modified one).
--
-- THE DEFECT. `plan_change_turn_active_workspace` validates only the row's OWN
-- tenant column:
--
--   USING / WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true))
--
-- Nothing tied `session_id` to that workspace, and **RLS does not traverse
-- foreign keys** — the FK's own lookup runs as the table owner with RLS
-- bypassed. So tenant A, under its own GUC and the non-bypass `prodect_app`
-- role, could INSERT a turn labelled `workspace_id = A` whose `session_id`
-- pointed at tenant B's conversation, and `WITH CHECK` passed.
--
-- THE IMPACT WAS AVAILABILITY, NOT CONFIDENTIALITY. `(session_id, seq)` is
-- UNIQUE and a unique index is enforced WITHOUT RLS, so the planted row claimed
-- a seq slot B could never use: B's next append allocates `seq` from its own
-- `turn_count`, collides (P2002 → PlanChangeTurnConflictError), rolls back —
-- so `turn_count` never advances and every retry re-collides on the same seq.
-- The victim's thread is wedged permanently. A could still never READ B's rows
-- (both policies hold on reads) and the planted row stayed invisible to B.
--
-- THE FIX — make the child's tenancy a STRUCTURAL fact, not a policy opinion.
-- `plan_change_turn`'s FK now references the PAIR `(id, workspace_id)` on
-- `plan_change_session` instead of `id` alone, so a turn can only attach to a
-- session in its own workspace: the offending row is now NONEXISTENT rather
-- than merely invisible. Chosen over a `WITH CHECK … EXISTS (SELECT … FROM
-- plan_change_session …)` subquery because it (a) costs no per-write subquery,
-- (b) cannot be forgotten by a future policy edit, and (c) unlike any policy
-- also holds for BYPASSRLS / superuser connections — which is precisely where
-- an RLS-only guard evaporates. The existing RLS policies are UNCHANGED and
-- still carry read isolation; this constraint is the layer beneath them.
--
-- The `UNIQUE (id, workspace_id)` below adds no integrity constraint of its own
-- (`id` is already the primary key) — Postgres simply requires a unique key on
-- the referenced column pair for a composite FK to target.
--
-- NOTE ON EXISTING ROWS: `ADD CONSTRAINT` validates the current table. If it
-- fails, that is not a migration bug — it means real cross-tenant turns exist
-- and must be triaged by hand. Deliberately NOT auto-deleted: that would
-- destroy the evidence of a tenancy breach.

-- DropForeignKey
ALTER TABLE "plan_change_turn" DROP CONSTRAINT "plan_change_turn_session_id_fkey";

-- CreateIndex
CREATE UNIQUE INDEX "plan_change_session_id_workspace_id_key" ON "plan_change_session"("id", "workspace_id");

-- AddForeignKey
ALTER TABLE "plan_change_turn" ADD CONSTRAINT "plan_change_turn_session_id_workspace_id_fkey" FOREIGN KEY ("session_id", "workspace_id") REFERENCES "plan_change_session"("id", "workspace_id") ON DELETE CASCADE ON UPDATE CASCADE;
