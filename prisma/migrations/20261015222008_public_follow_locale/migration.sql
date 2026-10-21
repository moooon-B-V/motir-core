-- MOTIR-8105: the language of the page an email-only follow was made from.
-- Nullable, no default, no backfill: existing follows read NULL (English).
ALTER TABLE "public_follow" ADD COLUMN "locale" TEXT;
