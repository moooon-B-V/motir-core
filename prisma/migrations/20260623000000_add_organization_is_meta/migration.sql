-- The META-org flag on the billing root (Organization). The internal dogfood org
-- (moooon B.V.) is the meta org: it resolves to the `meta` entitlement tier (every
-- §4 cap lifted) and the 8.1.8 AI paywall is disabled for it. DISTINCT from the
-- future commercial `enterprise` tier — `meta` is never billed and is excluded
-- from revenue (they share "unlimited" today only by coincidence).
--
-- The flag is also propagated to motir-ai on the job-submit envelope, so the AI
-- credit gate (out-of-credits) honours it too.
--
-- RLS: no policy change. The flag is read by the org's primary key (the cap reader
-- already holds the org row under bound org-context), and is only ever WRITTEN by
-- this data-flip + the seed (db-singleton) — no per-tenant write path.

-- AlterTable
ALTER TABLE "organization" ADD COLUMN     "isMeta" BOOLEAN NOT NULL DEFAULT false;

-- Data-flip: moooon B.V. is the meta org. Idempotent (keyed on the unique slug);
-- a no-op on any deployment whose org is not named `moooon`.
UPDATE "organization" SET "isMeta" = true WHERE "slug" = 'moooon';
