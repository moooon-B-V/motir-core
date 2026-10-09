-- Route every mid-run turn to the answering session (Story MOTIR-7990 · MOTIR-7996).
--
-- Three NULLABLE columns on `plan_change_turn`, no back-fill: a null reads exactly
-- as it did before. The table's RLS policies are row-level and unchanged.
--
--   run_job_id           the planning job running when a `user` turn was typed;
--                        marks it a mid-run turn (never opens a new planning run).
--   forward_offer        the text an `assistant` answer offered to forward.
--   forwarded_entry_id   the mailbox entry a mid-run `user` turn was forwarded as.

-- AlterTable
ALTER TABLE "plan_change_turn" ADD COLUMN     "forward_offer" TEXT,
ADD COLUMN     "forwarded_entry_id" TEXT,
ADD COLUMN     "run_job_id" TEXT;
