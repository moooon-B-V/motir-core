-- CreateTable
CREATE TABLE "legal_acceptance" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "document_slug" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legal_acceptance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "legal_acceptance_user_id_document_slug_idx" ON "legal_acceptance"("user_id", "document_slug");

-- CreateIndex
CREATE UNIQUE INDEX "legal_acceptance_user_id_document_slug_version_key" ON "legal_acceptance"("user_id", "document_slug", "version");

-- AddForeignKey
ALTER TABLE "legal_acceptance" ADD CONSTRAINT "legal_acceptance_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security — legal_acceptance (Story 8.4 · Subtask MOTIR-1135)
-- ===========================================================================
-- An agreement is between moooon B.V. and a PERSON, so the gate keys on the
-- `app.user_id` GUC rather than `app.workspace_id` — the `api_token` precedent
-- (Subtask 7.8.1), for the same reason: the row has no workspace, and it is
-- written at sign-up before any workspace exists to bind.
--
-- Every path that touches this table runs under `withUserContext`:
--   * the sign-up hook (`lib/auth/index.ts` databaseHooks.user.create.after),
--     which already holds the id of the user it just created;
--   * the re-consent gate's read, on a signed-in page load;
--   * the interstitial's "Agree and continue" write.
--
-- ⚠️ THERE IS NO `system_admin` ARM, and that is deliberate rather than an
-- omission to fix later. Nothing in the product needs to read one person's
-- agreements while acting as somebody else: there is no sweep, no digest and no
-- cross-tenant report over this table. Adding an arm "so an admin can look"
-- would make the whole acceptance history readable from any unbound connection,
-- which is the shape `public_follow`'s own comment records as a leak. A future
-- legal-hold export is a card that argues for its own arm, not a door to leave
-- open now.
--
-- `current_setting(..., true)` is missing_ok, so an unset GUC yields NULL, the
-- predicate is NULL, and the row is hidden — no context means nothing visible,
-- which is the safe failure.
ALTER TABLE "legal_acceptance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "legal_acceptance" FORCE ROW LEVEL SECURITY;

CREATE POLICY "legal_acceptance_owner" ON "legal_acceptance"
  FOR ALL
  USING ("user_id" = current_setting('app.user_id', true))
  WITH CHECK ("user_id" = current_setting('app.user_id', true));
