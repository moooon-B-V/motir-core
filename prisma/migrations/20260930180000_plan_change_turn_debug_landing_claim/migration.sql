-- MOTIR-7049 — the claim that keeps a `debug` turn's landing to EXACTLY ONE write
-- (`docs/decisions/conversation-turn-intent.md` AMENDMENT 1 · A1.4). The settle of
-- a `debug_bug` job sets it on the `user` turn by a compare-and-set under the
-- session's row lock before the card is written, so a replayed or concurrent
-- settle of the same job writes nothing.
--
-- Additive: nullable, no default, no row rewritten. RLS: `plan_change_turn`
-- already carries its policy, so none is added.

-- AlterTable
ALTER TABLE "plan_change_turn" ADD COLUMN     "debug_landing_claimed_at" TIMESTAMP(3);
