-- The TARGET index on `platform_audit_log` (MOTIR-1167).
--
-- Panel 9's "Support actions" card is the append-only log of every operator
-- write on ONE ACCOUNT, and neither index the table shipped with can serve that
-- query: `(actor_user_id, created_at)` answers "what did this operator do", and
-- `(organization_id, created_at)` is NULL for every user-targeted row.
--
-- ⚠️ IT IS NOT A SMALL TABLE AND WILL NOT STAY ONE. `console.open` writes a row
-- per admin PAGE VIEW (`app/(admin)/layout.tsx`), so the trail grows with
-- console usage rather than with operator ACTIONS — which is correct for the
-- SOC-2-style question it answers, and is exactly why the one read keyed by
-- target needs an index rather than a sequential scan that is fine today.
--
-- Composite on `(target_kind, target_id)` rather than `target_id` alone: the
-- column carries ids from five different tiers with no FK to disambiguate them
-- (the model's own comment says why there is no FK), so keying on the id alone
-- would make a cuid collision across tiers a cross-tier read rather than an
-- impossibility.
--
-- A plain index, declared in `schema.prisma` as well as here. A hand-written
-- PARTIAL one would have to stay clear of every `@@index` column list for ever
-- or `migrate diff` reports a permanent spurious rename (`CLAUDE.md`'s
-- migrations rule, MOTIR-1960).

CREATE INDEX "platform_audit_log_target_kind_target_id_created_at_idx"
  ON "platform_audit_log"("target_kind", "target_id", "created_at");
