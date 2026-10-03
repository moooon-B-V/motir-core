-- MOTIR-7316 — WHEN an outstanding CI-overage debit was first left unconfirmed
-- (Story MOTIR-6905, the fleet monitor's `running_not_debited` verdict).
--
-- The monitor needs the AGE of an outstanding debit, and `updated_at` cannot
-- give it: `ciAllowanceService.chargeForMeteredRun` rewrites the row (its
-- watermark and booked credits) on EVERY tick that meters something, pending
-- debit or not, so `updated_at` keeps moving for exactly as long as motir-ai
-- keeps refusing. This column is set when `pending_debit_ref` is first written,
-- kept while that slot stays occupied, and cleared with it.
--
-- ⚠️ NO RLS CLAUSE HERE, AND THAT IS NOT AN OMISSION. RLS is a per-TABLE policy;
-- this migration adds a column to a table that keeps its existing policies.
--
-- The backfill dates a debit ALREADY outstanding from the row's last write — the
-- latest instant it can have started, so a monitor reading it can only under-
-- rather than over-state how long it has been stuck. Idempotent.

ALTER TABLE "ci_period_charge" ADD COLUMN IF NOT EXISTS "pending_debit_since" TIMESTAMP(3);

UPDATE "ci_period_charge"
   SET "pending_debit_since" = "updated_at"
 WHERE "pending_debit_ref" IS NOT NULL
   AND "pending_debit_since" IS NULL;
