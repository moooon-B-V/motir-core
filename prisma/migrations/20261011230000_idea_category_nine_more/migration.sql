-- Story MOTIR-8273 (MOTIR-8276): nine new idea categories.
--
-- Forward-only: every statement adds an enum value at its grouped position and
-- touches no row, so no existing idea changes category. Nothing in this file
-- uses a new value, which is what lets Postgres (>= 12) run `ADD VALUE` inside
-- the migration's transaction.

-- Verticals, after public_sector.
ALTER TYPE "idea_category" ADD VALUE IF NOT EXISTS 'entertainment_media' AFTER 'public_sector';
ALTER TYPE "idea_category" ADD VALUE IF NOT EXISTS 'hospitality_travel' AFTER 'entertainment_media';
ALTER TYPE "idea_category" ADD VALUE IF NOT EXISTS 'mobility' AFTER 'hospitality_travel';
ALTER TYPE "idea_category" ADD VALUE IF NOT EXISTS 'energy_climate' AFTER 'mobility';
ALTER TYPE "idea_category" ADD VALUE IF NOT EXISTS 'manufacturing' AFTER 'energy_climate';
ALTER TYPE "idea_category" ADD VALUE IF NOT EXISTS 'local_services' AFTER 'manufacturing';

-- Consumer, after health_wellness and before ai_infrastructure.
ALTER TYPE "idea_category" ADD VALUE IF NOT EXISTS 'social_community' AFTER 'health_wellness';
ALTER TYPE "idea_category" ADD VALUE IF NOT EXISTS 'silver_economy' AFTER 'social_community';
ALTER TYPE "idea_category" ADD VALUE IF NOT EXISTS 'independent_work' AFTER 'silver_economy';
