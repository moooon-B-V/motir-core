-- better-auth 1.6.11 → 1.7.7 (Story MOTIR-7170 · Subtask MOTIR-7171). The schema
-- the 1.7 `@better-auth/oauth-provider` declares, diffed against 1.6.11's with the
-- library's own `getSchema` — nothing else in the set moved.
--
-- ⚠️ ADDITIVE, BECAUSE THE OLD BUILD IS STILL SERVING WHEN THIS RUNS. Fly applies
-- migrations in `release_command` BEFORE the new build takes traffic, so the
-- 1.6.11 build reads and writes these tables against THIS schema for a while.
-- Every column added is nullable or defaulted, so its inserts still succeed, and
-- nothing is dropped or renamed: `oauth_client.public` / `.type`, which 1.7 no
-- longer declares, stay until a later release drops them.
--
-- WHAT 1.7 ADDS. Protected resources become rows (`oauth_resource`, seeded at
-- boot from the provider's `resources` option — Motir has exactly one, the MCP)
-- with per-client links (`oauth_client_resource`, consulted only under
-- `enforcePerClientResources`, which Motir turns off). Tokens and consents record
-- the RFC 8707 resources they are bound to, the authorization code they came
-- from, and refresh-rotation replay state. `oauth_client_assertion` holds spent
-- `private_key_jwt` assertions; Motir registers only public clients, so it stays
-- empty. `oauth_client.client_discovery_id` records a client that was DISCOVERED
-- (a Client ID Metadata Document, MOTIR-7173) rather than registered.
--
-- THE ACCOUNT-IDENTITY BACKFILL. The 1.7.0 release notes key accounts on
-- `(issuer, accountId)`. 1.7.7's core `account` schema declares NO `issuer`
-- column (read back from `getSchema`) — that half belongs to the SSO plugin,
-- which Motir does not install — but the identity change still reaches Motir
-- through the CREDENTIAL account: 1.7 finds it by `account_id = user_id`
-- (`findCredentialAccount` and the email sign-in), where 1.6.11 matched on
-- `provider_id = 'credential'` alone. Better-Auth's own sign-up always wrote
-- `account_id = user_id`; Motir's `usersService.createUser` (the seed scripts
-- and fixtures) wrote the EMAIL there, so those accounts would stop signing in.
-- The UPDATE below re-keys them. The 1.6.11 build is indifferent to the value,
-- so it keeps signing the same accounts in after this runs. A user who somehow
-- already holds a correctly keyed credential row is left alone rather than
-- colliding on `(provider_id, account_id)`.
--
-- WHAT IT DOES NOT ADD. The device grant's
-- `oauthClientId` / `resources` columns belong to `oauthDeviceAuthorization()`,
-- the provider's own device grant, which Motir does not install; plain
-- `deviceAuthorization` (`motir login`) declares the same nine fields as before,
-- and the unique indexes 1.7 adds on `device_code` / `user_code` already exist.
--
-- `two_factor` gains 1.7's account-lockout counters (`failed_verification_count`,
-- `locked_until`). The plugin's schema declares them, so they exist; Motir turns
-- the lockout itself off to keep this upgrade free of behaviour change, so
-- nothing writes them yet.
--
-- Identity-scoped like the four tables MOTIR-6982 created: no RLS, for the same
-- reasons (registration and the token endpoint run with no session). Both FKs of
-- the link table are modelled as Prisma `@relation`s, with the plugin's cascades.
-- AlterTable
ALTER TABLE "oauth_access_token" ADD COLUMN     "authorization_code_id" TEXT,
ADD COLUMN     "confirmation" JSONB,
ADD COLUMN     "requested_user_info_claims" TEXT[],
ADD COLUMN     "resources" TEXT[],
ADD COLUMN     "revoked" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "oauth_client" ADD COLUMN     "application_type" TEXT,
ADD COLUMN     "backchannel_logout_session_required" BOOLEAN,
ADD COLUMN     "backchannel_logout_uri" TEXT,
ADD COLUMN     "client_credentials_scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "client_discovery_id" TEXT,
ADD COLUMN     "dpop_bound_access_tokens" BOOLEAN DEFAULT false,
ADD COLUMN     "jwks" TEXT,
ADD COLUMN     "jwks_uri" TEXT;

-- AlterTable
ALTER TABLE "oauth_consent" ADD COLUMN     "requested_user_info_claims" TEXT[],
ADD COLUMN     "resources" TEXT[];

-- AlterTable
ALTER TABLE "oauth_refresh_token" ADD COLUMN     "authorization_code_id" TEXT,
ADD COLUMN     "confirmation" JSONB,
ADD COLUMN     "requested_user_info_claims" TEXT[],
ADD COLUMN     "resources" TEXT[],
ADD COLUMN     "rotated_at" TIMESTAMP(3),
ADD COLUMN     "rotation_replay_expires_at" TIMESTAMP(3),
ADD COLUMN     "rotation_replay_response" TEXT;

-- CreateTable
CREATE TABLE "oauth_resource" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "access_token_ttl" INTEGER,
    "refresh_token_ttl" INTEGER,
    "signing_algorithm" TEXT,
    "signing_key_id" TEXT,
    "allowed_scopes" TEXT[],
    "custom_claims" JSONB,
    "dpop_bound_access_tokens_required" BOOLEAN DEFAULT false,
    "disabled" BOOLEAN DEFAULT false,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),
    "policy_version" INTEGER DEFAULT 1,
    "metadata" JSONB,

    CONSTRAINT "oauth_resource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_client_resource" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_client_resource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_client_assertion" (
    "id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oauth_client_assertion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "oauth_resource_identifier_key" ON "oauth_resource"("identifier");

-- CreateIndex
CREATE INDEX "oauth_client_resource_resource_id_idx" ON "oauth_client_resource"("resource_id");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_client_resource_client_id_resource_id_key" ON "oauth_client_resource"("client_id", "resource_id");

-- CreateIndex
CREATE INDEX "oauth_client_assertion_expires_at_idx" ON "oauth_client_assertion"("expires_at");

-- CreateIndex
CREATE INDEX "oauth_access_token_authorization_code_id_idx" ON "oauth_access_token"("authorization_code_id");

-- CreateIndex
CREATE INDEX "oauth_refresh_token_authorization_code_id_idx" ON "oauth_refresh_token"("authorization_code_id");

-- AddForeignKey
ALTER TABLE "oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_client"("client_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "oauth_resource"("identifier") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "two_factor" ADD COLUMN     "failed_verification_count" INTEGER DEFAULT 0,
ADD COLUMN     "locked_until" TIMESTAMP(3);

-- Backfill: credential accounts keyed by the user id, as 1.7 looks them up.
UPDATE "account" a
   SET "account_id" = a."user_id"
 WHERE a."provider_id" = 'credential'
   AND a."account_id" <> a."user_id"
   AND NOT EXISTS (
     SELECT 1 FROM "account" b
      WHERE b."provider_id" = 'credential'
        AND b."account_id" = a."user_id"
   );
