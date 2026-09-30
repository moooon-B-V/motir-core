-- An OAuth CONNECTION is an `api_token` row (Story MOTIR-6973 · Subtask MOTIR-6983).
--
-- What a person approves on the consent screen — one app, one workspace, one
-- project or none, one grant — is recorded as an `api_token` row carrying the
-- client it was approved for, instead of in a parallel table. The token row
-- already IS the reach model every MCP gate reads (bound workspace, one-arm
-- project binding, grant, last-used), and a second reach model would drift from
-- it. The provider's access tokens, refresh tokens and consent rows then point at
-- that row through the `reference_id` the consent decision stamps.
--
-- ADDITIVE AND SAFE ON EXISTING DATA. One nullable column, NULL on every existing
-- row (every existing row is a PAT, a device credential or a run token). The
-- `reference_id` columns are empty on every provider row until a consent is
-- approved, because nothing before this card wrote them.
--
-- DELETING A CONNECTION IS REVOKING IT. Every new foreign key cascades from
-- `api_token`, so one DELETE of the connection row removes its access tokens,
-- refresh tokens and consent in the same statement, and the next MCP call with
-- one of those tokens finds nothing (401). `api_token` is therefore no longer a
-- leaf; each of its deletes (revoke, the run-credential revoke, the erasure
-- sweep) now cascades into these three tables, which carry no RLS.

-- AlterTable
ALTER TABLE "api_token" ADD COLUMN     "oauth_client_id" TEXT;

-- CreateIndex
CREATE INDEX "api_token_oauth_client_id_idx" ON "api_token"("oauth_client_id");

-- CreateIndex
CREATE INDEX "oauth_access_token_reference_id_idx" ON "oauth_access_token"("reference_id");

-- CreateIndex
CREATE INDEX "oauth_consent_reference_id_idx" ON "oauth_consent"("reference_id");

-- CreateIndex
CREATE INDEX "oauth_refresh_token_reference_id_idx" ON "oauth_refresh_token"("reference_id");

-- AddForeignKey
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_reference_id_fkey" FOREIGN KEY ("reference_id") REFERENCES "api_token"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_reference_id_fkey" FOREIGN KEY ("reference_id") REFERENCES "api_token"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_reference_id_fkey" FOREIGN KEY ("reference_id") REFERENCES "api_token"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_token" ADD CONSTRAINT "api_token_oauth_client_id_fkey" FOREIGN KEY ("oauth_client_id") REFERENCES "oauth_client"("client_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ONE CONNECTION PER (person, client, workspace, project) — hand-written, because
-- Prisma can express neither the predicate nor the expression. Approving the same
-- app for the same place twice, including twice AT ONCE, must leave one row: the
-- service writes through `INSERT … ON CONFLICT` against exactly this index, so the
-- losing writer gets the winner's row back instead of an error or a duplicate.
-- `COALESCE(project_id, '')` makes the all-projects connection (NULL project)
-- collide with itself, which a plain unique index on a nullable column would not
-- do. PAT rows are outside the predicate, so a person's tokens are unconstrained.
CREATE UNIQUE INDEX "api_token_oauth_connection_key"
  ON "api_token" ("user_id", "oauth_client_id", "workspace_id", COALESCE("project_id", ''))
  WHERE "oauth_client_id" IS NOT NULL;
