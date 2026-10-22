-- The plan offer on an answer turn (MOTIR-9219 · MOTIR-9288). One nullable JSON
-- column, no backfill (absent reads as "no offer", which is every earlier turn) and
-- no index (nothing queries by the offer; the thread is read by session). The column
-- inherits the table's existing row security.
ALTER TABLE "plan_change_turn" ADD COLUMN "answer_offer" JSONB;
