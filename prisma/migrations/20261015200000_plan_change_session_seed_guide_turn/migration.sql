-- Story MOTIR-8684 · Subtask MOTIR-8691: a planning SESSION remembers the GUIDE
-- re-plan offer that seeded it (decision MOTIR-8685), beside `seed_gate_id`.
--
-- ADDITIVE, nullable, no backfill: no existing session was seeded by a guide offer,
-- so NULL is the correct and complete answer for every existing row, and the
-- still-serving build neither reads nor names the column. RLS is unchanged:
-- `plan_change_session` keeps its workspace-scoped policy, and the column adds no
-- predicate.
--
-- `ON DELETE SET NULL`: a turn that goes (its session's cascade) leaves the planning
-- conversation intact and merely unseeded.
--
-- At most one of the two seeds is ever set: the CHECK is the DB backstop for the
-- service's rule.

-- AlterTable
ALTER TABLE "plan_change_session" ADD COLUMN     "seed_guide_turn_id" TEXT;

-- CreateIndex
CREATE INDEX "plan_change_session_seed_guide_turn_id_created_by_id_last_a_idx" ON "plan_change_session"("seed_guide_turn_id", "created_by_id", "last_activity_at");

-- AddForeignKey
ALTER TABLE "plan_change_session" ADD CONSTRAINT "plan_change_session_seed_guide_turn_id_fkey" FOREIGN KEY ("seed_guide_turn_id") REFERENCES "plan_change_turn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddCheck
ALTER TABLE "plan_change_session" ADD CONSTRAINT "plan_change_session_one_seed" CHECK (num_nonnulls("seed_gate_id", "seed_guide_turn_id") <= 1);
