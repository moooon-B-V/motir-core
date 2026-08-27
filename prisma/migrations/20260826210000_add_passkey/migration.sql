-- WebAuthn credentials — passkeys (Story MOTIR-1214 · Subtask MOTIR-3610).
-- Better-Auth's `@better-auth/passkey` plugin owns this table outright: it comes
-- from the plugin's own `src/schema.ts`, and every read and write goes through
-- its Prisma adapter. Motir adds no column of its own here (unlike `device_code`,
-- which carries two).
--
-- ADDITIVE AND SAFE ON EXISTING DATA. It is a new table and nothing else changes
-- — no column is added to `user`, because a passkey needs no per-user flag: the
-- Security pane asks whether the user HAS any rows here, and `twoFactorEnabled`
-- (added by 20260826150000_add_two_factor) stays about the `twoFactor` plugin's
-- own enrolment. The table starts empty and nothing reads it until someone
-- registers a credential.
--
-- NOTHING IN HERE IS A SECRET. `public_key` is the credential's PUBLIC half and
-- `credential_id` is its identifier; the private key never leaves the user's
-- device, which is the entire security property of a passkey. A dump of this
-- table authenticates nobody. That is why — unlike `two_factor`, whose two
-- columns are symmetric-encrypted before insert — there is no encryption step
-- here to describe.
--
-- TENANCY DECISION: identity-scoped, NOT workspace-scoped, so it ships with
-- NO RLS — the `two_factor` / `verification` / `email_change_request` /
-- `device_code` precedent, not the workspace-RLS table contract (the sprint /
-- sprint_report_entry shape: NOT NULL workspace_id + FORCE ROW LEVEL SECURITY +
-- a policy on current_setting('app.workspace_id')). Three reasons, in order of
-- weight:
--
--   1. There is NO TENANT DISCRIMINATOR to gate on, at any point in the row's
--      life. A passkey is a property of the PERSON and of their DEVICE: a user
--      who belongs to four workspaces registers one passkey on their laptop, and
--      one who belongs to none can still register it. A workspace_id column here
--      would be a fiction invented to satisfy the contract.
--   2. It is READ PRE-AUTH, and more completely so than `two_factor` is.
--      `/passkey/generate-authenticate-options` and `/passkey/verify-authentication`
--      run before there is ANY session — before even the password step, since a
--      passkey replaces the password rather than following it — so there is no
--      `app.workspace_id` GUC for a policy to consult. A policy here would hide
--      the row from its only legitimate reader.
--   3. The ASSERTION is the capability. Reaching a row means producing a
--      signature from a private key held in the user's authenticator, unlocked by
--      a fingerprint, a face or a device PIN (the registration pins
--      `userVerification: 'required'`). Authorization is that assertion, not row
--      visibility.
--
-- `user_id` is INDEXED and deliberately NOT UNIQUE: the plugin's own schema
-- declares an index, and a person is EXPECTED to hold several passkeys — one per
-- device is the shape the feature is for. `credential_id` is indexed because the
-- authentication path looks a row up by it, and is likewise not unique, matching
-- the plugin: the duplicate case already has a typed answer
-- (`PREVIOUSLY_REGISTERED`), and a constraint here would surface instead as a raw
-- P2002 thrown inside the plugin where no typed error can catch it.
--
-- NO CHALLENGE TABLE and no TTL sweep: the plugin keeps the in-flight WebAuthn
-- challenge in a cookie (`advanced.webAuthnChallengeCookie`, 300 seconds), so
-- there is no pending state for this table to hold.
--
-- No explicit GRANT is needed: the table is created by the `prodect` role, which
-- already owns the schema (same as verification / email_change_request /
-- device_code / two_factor).

-- CreateTable
CREATE TABLE "passkey" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "public_key" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "credential_id" TEXT NOT NULL,
    "counter" INTEGER NOT NULL,
    "device_type" TEXT NOT NULL,
    "backed_up" BOOLEAN NOT NULL,
    "transports" TEXT,
    "aaguid" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "passkey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "passkey_user_id_idx" ON "passkey"("user_id");

-- CreateIndex
CREATE INDEX "passkey_credential_id_idx" ON "passkey"("credential_id");

-- AddForeignKey
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
