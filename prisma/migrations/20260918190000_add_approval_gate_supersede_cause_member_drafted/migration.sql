-- ============================================================
-- A GATE WITHDRAWN BECAUSE A MEMBER WENT BACK TO DRAFT (MOTIR-5699).
-- ============================================================
-- `approval_gate_supersede_cause` holds ONE value per writing path
-- (MOTIR-5659). Converting a pull request back to a draft is a new path: the
-- author has taken the set out of review, so the approve-and-merge question
-- over it is retired. None of the existing causes says that — the commits did
-- not move (`head_moved`), nothing closed (`member_closed`) and no delivery row
-- joined or left (`set_changed`) — so it gets its own member rather than
-- borrowing a sentence that would be false on the card.
--
-- Additive only: no existing row changes, and no backfill is owed, because no
-- row was ever superseded for this reason before the path existed.

ALTER TYPE "approval_gate_supersede_cause" ADD VALUE 'member_drafted';
