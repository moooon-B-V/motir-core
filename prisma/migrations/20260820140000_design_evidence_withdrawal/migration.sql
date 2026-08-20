-- MOTIR-3215 — a design result can be WITHDRAWN, and the record says so.
--
-- `design_evidence` shipped with exactly two mutations: create a row, and
-- supersede the current one by publishing another. Both need a REPLACEMENT, so
-- a result published onto a card that will never have a design of its own could
-- never be cleared by any route, service or surface — the row was permanent.
-- MOTIR-3213's publisher defect made that reachable in production.
--
-- Withdrawal is `is_current -> false` with nothing taking the slot. That much
-- the existing flag already expresses; what it CANNOT express is which of two
-- histories a `false` row is. Hence the stamp:
--
--   is_current = false, withdrawn_at IS NULL     -> a later publish superseded it
--   is_current = false, withdrawn_at IS NOT NULL -> somebody took it back
--   no row at all                                -> the card never had a design
--
-- The third is what the design gate reads, so a withdrawal that left no trace
-- would convert one silent wrong answer into a different silent wrong answer.
--
-- `withdrawn_by_id` NULL *with* `withdrawn_at` set means the SYSTEM withdrew it
-- — the shape the data-repair migration beside this one writes. That is the
-- same three-histories legibility `plan.decision_reason` (MOTIR-3189) added one
-- table over, and the null pattern is RECORDED here rather than left to be
-- reverse-engineered from which timestamps happen to be empty.
--
-- NULLABLE with no backfill: every row written before this migration genuinely
-- has no withdrawal, and `withdrawn_at IS NULL` is the true answer for all of
-- them.

ALTER TABLE "design_evidence"
  ADD COLUMN "withdrawn_at"     TIMESTAMP(3),
  ADD COLUMN "withdrawn_by_id"  TEXT,
  ADD COLUMN "withdrawn_reason" TEXT;

-- Modelled as `DesignEvidence.withdrawnBy` <-> `User.withdrawnDesignEvidences`
-- in schema.prisma with the SAME SetNull action, per the FK-`@relation` rule in
-- CLAUDE.md: a raw-SQL-only FK puts the schema graph and the migration-built DB
-- in permanent drift and the next `migrate dev` re-proposes a DROP for it.
ALTER TABLE "design_evidence"
  ADD CONSTRAINT "design_evidence_withdrawn_by_id_fkey"
  FOREIGN KEY ("withdrawn_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
