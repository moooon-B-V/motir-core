-- ============================================================
-- A GATE WITHDRAWN BECAUSE A MEMBER CONFLICTS WITH ITS BASE (MOTIR-5914,
-- for bug MOTIR-5907; design/github § 30).
-- ============================================================
-- `approval_gate_supersede_cause` holds ONE value per writing path
-- (MOTIR-5659). A member the host reports `dirty` — found when a push to the
-- base branch re-reads it, or at the press — is a new path: the commits cannot
-- combine with the base, so the approve-and-merge question over the set is
-- retired before anybody presses a button guaranteed to fail. None of the
-- existing causes says that — nothing moved (`head_moved`), closed
-- (`member_closed`) or went back to draft (`member_drafted`) — so it gets its
-- own member.
--
-- Additive only: no existing row changes, and no backfill is owed, because no
-- row was ever superseded for this reason before the path existed.

ALTER TYPE "approval_gate_supersede_cause" ADD VALUE 'conflict';
