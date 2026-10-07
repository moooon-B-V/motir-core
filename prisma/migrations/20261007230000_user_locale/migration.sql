-- Story MOTIR-7730 · MOTIR-7743: the person's saved interface language.
-- Expand-only: a nullable column with no default and no backfill. NULL means
-- "nothing saved", and resolution falls through to the browser's choice.
ALTER TABLE "user" ADD COLUMN "locale" TEXT;
