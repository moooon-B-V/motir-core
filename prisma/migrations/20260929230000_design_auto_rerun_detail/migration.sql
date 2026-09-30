-- Story MOTIR-693 · MOTIR-702 — the automatic re-run line names who, which model or
-- which repository a skip was about; captured when the record is written.
ALTER TABLE "design_auto_rerun" ADD COLUMN "detail" TEXT;
