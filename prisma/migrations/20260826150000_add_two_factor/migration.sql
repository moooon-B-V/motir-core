-- Two-factor authentication material (Story MOTIR-1213 · Subtask MOTIR-1217).
-- Better-Auth's official `twoFactor` plugin owns this table and the new `user`
-- column outright: both come from `plugins/two-factor/schema.mjs`, and every read
-- and write goes through the plugin's Prisma adapter. Motir adds no column of its
-- own here (unlike `device_code`, which carries two).
--
-- ADDITIVE AND SAFE ON EXISTING DATA. The one column added to `user` is
-- NOT NULL DEFAULT false, so every existing row becomes `twoFactorEnabled =
-- false` — no backfill, no rewrite of a nullable to a required column later.
-- `two_factor` is a new table, so it starts empty and nothing reads it until a
-- user enrols.
--
-- TENANCY DECISION: identity-scoped, NOT workspace-scoped, so it ships with
-- NO RLS — the `verification` / `email_change_request` / `device_code`
-- precedent, not the workspace-RLS table contract (the sprint /
-- sprint_report_entry shape: NOT NULL workspace_id + FORCE ROW LEVEL SECURITY +
-- a policy on current_setting('app.workspace_id')). Three reasons, in order of
-- weight:
--
--   1. There is NO TENANT DISCRIMINATOR to gate on, at any point in the row's
--      life. Two-factor enrolment is a property of the PERSON, not of a tenant:
--      a user who belongs to four workspaces has one 2FA secret, and one who
--      belongs to none can still enrol. A workspace_id column here would be a
--      fiction invented to satisfy the contract.
--   2. It is READ PRE-AUTH, on the login challenge. `/two-factor/verify-totp`
--      and its siblings run AFTER the password step and BEFORE a session
--      exists — the caller holds only the signed `two_factor` cookie — so
--      there is no `app.workspace_id` GUC for a policy to consult. A policy
--      here would hide the row from its only legitimate reader. (Exactly the
--      reason `email_change_request` carries no RLS: the user clicking the
--      confirm link may have no session either.)
--   3. The COOKIE is the capability. Reaching a row at all requires the signed,
--      short-lived two-factor cookie minted by the password step, or an
--      authenticated session for the management endpoints. Authorization is
--      that cookie, not row visibility.
--
-- Both secrets in this table are SYMMETRIC-ENCRYPTED with BETTER_AUTH_SECRET
-- before insert (the plugin's `symmetricEncrypt`; `storeBackupCodes:
-- 'encrypted'` in lib/auth/index.ts). They are encrypted rather than hashed
-- because the plugin has no hashed arm — verifying a backup code means decoding
-- the stored set and searching it. So a database dump alone does not yield a
-- usable TOTP seed or a usable recovery code.
--
-- `user_id` is INDEXED and deliberately NOT UNIQUE: the plugin's own schema
-- declares an index, and enable runs `deleteMany({userId}) → create(...)`, so a
-- unique constraint would turn a lost race between two concurrent enrolments
-- into a raw P2002 thrown inside the plugin where no typed error can catch it.
-- `secret` is indexed because the plugin's schema declares that too.
--
-- NO trusted-device table: "don't ask again on this device" is a
-- `trust-device-<random>` row in the EXISTING `verification` table plus a signed
-- cookie (`plugins/two-factor/verify-two-factor.mjs`).
--
-- No explicit GRANT is needed: the table is created by the `prodect` role, which
-- already owns the schema (same as verification / email_change_request /
-- device_code / api_token).

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "two_factor" (
    "id" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "backup_codes" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "two_factor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "two_factor_secret_idx" ON "two_factor"("secret");

-- CreateIndex
CREATE INDEX "two_factor_user_id_idx" ON "two_factor"("user_id");

-- AddForeignKey
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
