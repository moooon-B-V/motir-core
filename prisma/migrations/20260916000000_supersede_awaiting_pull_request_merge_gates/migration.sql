-- MOTIR-5614 — SUPERSEDE every awaiting `pull_request_merge` gate.
-- ===========================================================================
-- Bug MOTIR-5603, and `docs/decisions/approval-gates.md` §8's SECOND AMENDMENT,
-- decisions 1 and 8. A card in a `manual` project was given TWO approve-to-merge
-- gates — one per pull request beside the one per card — so To approve listed
-- the same pull request twice. There is now ONE gate per card, and approving it
-- merges every pull request the card delivers.
--
-- MOTIR-5611 stopped the raise. This closes the rows it already made: without
-- it, every merge gate raised before that change sits `awaiting` for ever —
-- routed to somebody, counted in their To-approve tab, and decidable by nothing
-- once MOTIR-5616 removes its handler from the registry.
--
-- SUPERSEDED, NOT DELETED, and the product writes the same state itself when a
-- pull request's head moves under a gate. These gates were genuinely raised and
-- genuinely waiting; what changed is the model, not whether they existed.
--
-- THE SCOPE IS DELIBERATELY NARROW — `kind = 'pull_request_merge'` AND
-- `state = 'awaiting'`, nothing else:
--
--   · a DECIDED row of this kind records a merge that really happened and is
--     left exactly as it is. `trg_approval_gate_decided_immutable`
--     (20260910120000) refuses to edit one, so widening this WHERE would fail
--     loudly rather than corrupt quietly — but the scope is stated so that
--     nobody widens it;
--   · a gate of any OTHER kind is a live question somebody still has to answer.
--
-- ⚠️ THE ENUM MEMBER `pull_request_merge` IS DELIBERATELY KEPT. Every row this
-- migration just superseded still references it, as does every decided one, so
-- dropping the member from `approval_gate_kind` (20260908210000) would orphan
-- the exact rows written here. The kind retires at the REGISTRY tier
-- (MOTIR-5616 moves it to `UNREGISTERED_GATE_KINDS`), never in Postgres. The
-- obvious next edit is to tidy the enum up; this is the note saying not to.
--
-- IDEMPOTENT: a second run finds nothing `awaiting` of that kind and writes
-- zero rows. It also empties `approval_gate_one_awaiting_per_subject` of this
-- kind, which is the point — the index now constrains nothing nobody raises.

UPDATE "approval_gate"
SET "state" = 'superseded',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "kind" = 'pull_request_merge'
  AND "state" = 'awaiting';
