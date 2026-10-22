-- The claim on a targeted "plan this" turn's one start (MOTIR-9219 · MOTIR-9291). One
-- nullable timestamp, no backfill (null reads as "never started", which is every
-- earlier turn) and no index (it is read and written by the turn's id). The column
-- inherits the table's existing row security.
ALTER TABLE "plan_change_turn" ADD COLUMN "plan_start_claimed_at" TIMESTAMP(3);
