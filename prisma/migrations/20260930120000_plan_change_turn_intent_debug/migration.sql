-- MOTIR-7047 — the project conversation's THIRD turn intent, `debug`
-- (`docs/decisions/conversation-turn-intent.md` AMENDMENT 1 · A1.6). A `user` turn
-- that `ask_project` classified as a report of broken behaviour is recorded as
-- `debug` once motir-core dispatches its `debug_bug` job. The column's rules are
-- unchanged: nullable, set on `user` turns only, the effective disposition.
--
-- Additive: no row is rewritten, and nothing in THIS transaction uses the new
-- value. RLS: `plan_change_turn` already carries its policy, so none is added.

-- AlterEnum
ALTER TYPE "plan_change_turn_intent" ADD VALUE 'debug';
