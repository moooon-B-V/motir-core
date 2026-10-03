-- MOTIR-7502 — the leg's self-reported model. Column only: legs written before
-- the writer deploys are back-filled by a later, separate migration (MOTIR-7503),
-- so no `agent_exited` that lands between this migration and the writer going
-- live is missed.
ALTER TABLE "dispatch_run_card" ADD COLUMN "model" TEXT;
