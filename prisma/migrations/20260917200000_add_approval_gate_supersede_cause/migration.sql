-- ============================================================
-- A SUPERSEDED GATE RECORDS WHY (Story MOTIR-5652 · MOTIR-5659).
-- ============================================================
-- `design-result.md` AMENDMENT 6 Q5 and `approval-gates.md` §6b's MOTIR-5658
-- amendment. §6b made a supersede write `state` and NOTHING else, so the row
-- cannot tell its causes apart — and every surface rendering one has to guess or
-- go vague.
--
-- That is two shipped defects, not a theoretical gap. MOTIR-5586 and MOTIR-5651
-- are the SAME false sentence on two surfaces — "a newer design was published …
-- the current version is above" — true for exactly one of the writing paths and
-- false for the rest. Both were repaired by making the sentence vaguer, because
-- while the row is silent the vague sentence is the only honest one available.
-- This column is what lets the honest sentence also be the useful one.
--
-- ⚠️ NULLABLE, AND THAT IS NOT THE "UNSAID" HOLE. A live supersede always supplies
-- a cause, because the repository writes take it as a REQUIRED argument — so null
-- here means the row was never superseded at all. What an optional ARGUMENT would
-- have bought is the eighth superseding path, written months from now by somebody
-- who does not know this history, quietly writing a row that says nothing.
--
-- ⚠️ THE BACKFILL WRITES `unknown`, AND NEVER GUESSES. Rows superseded before this
-- migration genuinely do not know what happened to them. Reconstructing a cause
-- from a row's shape — "it had a newer sibling, so call it republished" — would be
-- right often enough to be believed and wrong often enough to matter, and once a
-- surface renders it, it is indistinguishable from a recorded fact. `unknown` is
-- rendered as "the reason was not recorded", which stays true whatever the row
-- turns out to have been.
--
-- ⚠️ IT ADDS NO ACTOR AND NO NOTE. §6b's guarantee is that the audit can never
-- read a withdrawn question as a human decision; a cause says what HAPPENED to the
-- question, and must not soften that line.

CREATE TYPE "approval_gate_supersede_cause" AS ENUM (
  'republished',
  'withdrawn',
  'head_moved',
  'member_closed',
  'set_changed',
  'pulled_back',
  'unknown'
);

ALTER TABLE "approval_gate"
  ADD COLUMN "superseded_cause" "approval_gate_supersede_cause";

-- Every row that is ALREADY superseded predates the column. `unknown` is the only
-- honest value for them, and this statement is its only writer: no live path may
-- ever write it (AMENDMENT 6 Q5).
UPDATE "approval_gate"
SET "superseded_cause" = 'unknown'
WHERE "state" = 'superseded'
  AND "superseded_cause" IS NULL;
