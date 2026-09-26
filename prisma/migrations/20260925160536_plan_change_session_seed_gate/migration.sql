-- Story MOTIR-6068 · Subtask MOTIR-6207: a planning SESSION remembers the REFUSED
-- gate that seeded it (`docs/decisions/agent-authored-plans.md` AMENDMENT 17 §9).
--
-- ADDITIVE, nullable, no backfill: no existing session was seeded, so NULL is the
-- correct and complete answer for every existing row, and the still-serving build
-- neither reads nor names the column (the ordinary migrate-then-serve order is
-- safe). RLS is unchanged: `plan_change_session` keeps its workspace-scoped
-- policy, and the column adds no predicate.
--
-- `ON DELETE SET NULL`: a gate row that goes (its work item's or project's
-- cascade) leaves the conversation intact and merely unseeded — a session is
-- never deleted because its seed was.

-- AlterTable
ALTER TABLE "plan_change_session" ADD COLUMN     "seed_gate_id" TEXT;

-- CreateIndex
CREATE INDEX "plan_change_session_seed_gate_id_created_by_id_last_activit_idx" ON "plan_change_session"("seed_gate_id", "created_by_id", "last_activity_at");

-- AddForeignKey
ALTER TABLE "plan_change_session" ADD CONSTRAINT "plan_change_session_seed_gate_id_fkey" FOREIGN KEY ("seed_gate_id") REFERENCES "approval_gate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
