-- MOTIR-6907 · docs/decisions/fleet-per-org-pool.md §2: fleet capacity is per
-- organisation.

-- The enterprise override of MOTIR_FLEET_ORG_MAX_IN_FLIGHT, set by platform
-- staff on the org row. NULL = the environment's number.
ALTER TABLE "organization" ADD COLUMN "fleet_pool_cap" INTEGER;

-- A slot now counts against its organisation's pool, so it must name one. Every
-- writer already passes the org; a row without one is debris from before the
-- pool existed that no org's count could see. Slots are short-lived (their
-- `expires_at` safety net is at most hours), so removing such a row frees no
-- capacity a live, attributed container is holding.
DELETE FROM "fleet_in_flight_slot" WHERE "organization_id" IS NULL;
ALTER TABLE "fleet_in_flight_slot" ALTER COLUMN "organization_id" SET NOT NULL;

-- The per-organisation pool count, read under the fleet admission lock.
CREATE INDEX "fleet_in_flight_slot_organization_id_expires_at_idx" ON "fleet_in_flight_slot"("organization_id", "expires_at");
