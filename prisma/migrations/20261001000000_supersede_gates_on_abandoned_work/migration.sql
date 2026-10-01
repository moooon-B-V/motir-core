-- MOTIR-7109 — WITHDRAW every awaiting gate whose work item is ARCHIVED or CANCELLED.
-- ===========================================================================
-- Archiving a card and moving it to Cancelled now withdraw its `awaiting` gates
-- in the same transaction, every kind alike (`withdrawQuestionsOnArchive`; the
-- funnel's Cancelled rule in `workItemsService.applyStatusTransition`, which no
-- longer exempts a system write). Before that, an archive never withdrew
-- anything and a SYSTEM cancel — the parent cascade, the importer — skipped the
-- pull-back rule, so gates raised on abandoned work sit `awaiting` for ever:
-- routed to somebody, counted in their To-approve tab, marked on the board, and
-- (until the decide door's MOTIR-7109 backstop) approvable.
--
-- This closes the rows those paths already left. SUPERSEDED, NOT DELETED, with
-- the cause the product writes for the same withdrawal (`pulled_back`): these
-- gates were genuinely raised; what changed is that the work they ask about
-- was abandoned.
--
-- THE SCOPE IS `state = 'awaiting'` ONLY. A decided row records an answer
-- somebody gave and `trg_approval_gate_decided_immutable` refuses to edit one,
-- so widening the WHERE would fail loudly rather than corrupt quietly. A
-- card-less gate (`work_item_id IS NULL`, a plan's) has no work item and is
-- untouched by the join.
--
-- IDEMPOTENT: a second run finds nothing awaiting on such a card.

UPDATE "approval_gate" AS g
SET "state" = 'superseded',
    "superseded_cause" = 'pulled_back',
    "updated_at" = CURRENT_TIMESTAMP
FROM "work_item" AS w
WHERE g."work_item_id" = w."id"
  AND g."state" = 'awaiting'
  AND (w."archivedAt" IS NOT NULL OR w."status" = 'cancelled');
