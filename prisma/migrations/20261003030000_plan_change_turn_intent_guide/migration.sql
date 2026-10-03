-- MOTIR-7464 — the project conversation's FOURTH turn intent, `guide`, and the
-- session origin that carries it (`docs/decisions/conversation-turn-intent.md`
-- AMENDMENT 2 · A2.1 / A2.2). A guide conversation is opened by the Guide me
-- through door on ONE manual card: its session's `origin` is `guide`, and every
-- user turn on it is recorded as `guide` when its `guide_work_item` job is
-- submitted. The columns' rules are unchanged.
--
-- Additive: no row is rewritten, and nothing in THIS transaction uses either new
-- value. RLS: `plan_change_session` and `plan_change_turn` already carry their
-- policies, so none is added.

-- AlterEnum
ALTER TYPE "plan_change_turn_intent" ADD VALUE 'guide';

-- AlterEnum
ALTER TYPE "plan_session_origin" ADD VALUE 'guide';
