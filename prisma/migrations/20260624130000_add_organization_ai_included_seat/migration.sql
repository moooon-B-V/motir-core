-- A PAID Motir AI plan BUNDLES 1 Motir seat, which lifts the §4 caps (ADR §4,
-- amended 2026-06-24 / 8.1.22 / MOTIR-1316). This LOCAL flag mirrors motir-ai's
-- PlanTier state (propagated by 8.1.23 via POST /api/internal/billing/
-- ai-included-seat), so the hot-path cap gate (8.1.11) reads it without a
-- per-create cross-service call. Distinct from scaledTrackerSubscription (a
-- team's PURCHASED seats) so the two never clobber. RLS: no policy change — the
-- existing organization_mutate_active UPDATE policy gates on the active-org GUC.

-- AlterTable
ALTER TABLE "organization" ADD COLUMN     "aiIncludedSeat" BOOLEAN NOT NULL DEFAULT false;
