-- Story MOTIR-7459 · MOTIR-7470 — landing a guide turn's result
-- (`docs/decisions/conversation-turn-intent.md` AMENDMENT 2, A2.4).
--
-- `guide_landing_claimed_at` is the exactly-once claim on a guide turn's writes,
-- set on the `user` turn before anything lands (the debug claim's shape).
-- `guide_turn` is the assistant turn's record of the job's actions and what each
-- one did. Both nullable, no backfill: every existing turn is not a guide turn.

ALTER TABLE "plan_change_turn" ADD COLUMN "guide_landing_claimed_at" TIMESTAMP(3);
ALTER TABLE "plan_change_turn" ADD COLUMN "guide_turn" JSONB;
