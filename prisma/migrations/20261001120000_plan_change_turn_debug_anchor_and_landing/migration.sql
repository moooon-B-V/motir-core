-- MOTIR-7064 — what the rail needs to redraw a settled `debug` turn after a
-- reload (`docs/decisions/conversation-turn-intent.md` AMENDMENT 1 · A1.2 / A1.4):
--   * `anchor_key` — the work item a `user` turn was anchored on (the report
--     widget's triage bug), as its resolved identifier;
--   * `debug_landing` — the landing a `debug` turn's `assistant` reply carries
--     (`{ outcome, workItemKey, title, createdInTriage }`), written in the same
--     append as the reply.
--
-- Additive: both nullable, no default, no row rewritten — a turn written before
-- this keeps null and renders exactly as it did. RLS: `plan_change_turn` already
-- carries its policy, so none is added.

-- AlterTable
ALTER TABLE "plan_change_turn" ADD COLUMN     "anchor_key" TEXT,
ADD COLUMN     "debug_landing" JSONB;
