-- CreateTable
CREATE TABLE "public_follow" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "user_id" TEXT,
    "email" TEXT,
    "digest_opt_in" BOOLEAN NOT NULL DEFAULT false,
    "confirmed_at" TIMESTAMP(3),
    "confirm_token_hash" TEXT,
    "confirm_token_expires_at" TIMESTAMP(3),
    "last_digest_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "public_follow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "public_follow_project_id_digest_opt_in_idx" ON "public_follow"("project_id", "digest_opt_in");

-- CreateIndex
CREATE INDEX "public_follow_workspace_id_idx" ON "public_follow"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "public_follow_project_id_user_id_key" ON "public_follow"("project_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "public_follow_project_id_email_key" ON "public_follow"("project_id", "email");

-- AddForeignKey
ALTER TABLE "public_follow" ADD CONSTRAINT "public_follow_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public_follow" ADD CONSTRAINT "public_follow_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public_follow" ADD CONSTRAINT "public_follow_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- public_follow — the CHECK and the RLS policy Prisma cannot express
-- (Story 8.9 · Subtask 8.9.3 · docs/decisions/public-follow-and-changelog.md)
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- EXACTLY ONE IDENTITY, as a database invariant
-- ---------------------------------------------------------------------------
-- Two of the three follower tiers are rows here (the third, anonymous, is a
-- feed subscription and stores nothing): an ACCOUNT follow carries `user_id`,
-- an EMAIL-ONLY follow carries `email`. Never both, never neither.
--
-- The service enforces it too. This constraint exists because an invariant one
-- service enforces is an invariant a second service will one day not enforce —
-- and the failure mode here is a row that is in NEITHER tier, which no digest
-- sweep and no unsubscribe path can address, so it is unreachable rather than
-- merely wrong.
--
-- `<>` on two booleans is XOR, and neither operand can be NULL (`IS NULL`
-- always yields true or false), so the constraint is total: no row satisfies it
-- vacuously the way a three-valued comparison would.
ALTER TABLE "public_follow"
  ADD CONSTRAINT "public_follow_identity_exactly_one"
  CHECK (("user_id" IS NULL) <> ("email" IS NULL));

-- ---------------------------------------------------------------------------
-- RLS: the ORDINARY workspace gate, and deliberately nothing else
-- ---------------------------------------------------------------------------
-- `workspace_id` is denormalized from the project (the `work_item_link` shape),
-- so this table takes the same single PERMISSIVE FOR ALL policy every
-- workspace-scoped table takes. Its one non-obvious property is what is NOT
-- here.
--
-- ⚠️ THERE IS NO ANONYMOUS PUBLIC-PROJECT ARM, AND THAT IS THE SECURITY
-- PROPERTY. The obvious precedent is `public_request_vote`, the other
-- public-write table: no `workspace_id`, an owner policy
-- (`user_id = app.user_id`), plus a `..._public_project_read` arm gated on
-- there being no bound workspace. Copying it here would be a subscriber-email
-- leak, for a reason specific to this table:
--
--   * EVERY `public_request_vote` row has a `user_id` — voting requires
--     sign-in — so its owner policy covers the whole table.
--   * An EMAIL-ONLY `public_follow` row has NO acting user. An owner policy can
--     never reach it, and the only key an unbound connection could be gated on
--     is "this project is public" — which is true of every row on the table.
--     A FOR ALL arm of that shape makes the entire follower list, addresses
--     included, readable and enumerable by any anonymous connection.
--
-- The repair is not a narrower arm; it is having a tenant to bind. The row's
-- workspace is known before the write — it is the project's, resolved
-- server-side from the public identifier the request already names — so every
-- write runs inside `withWorkspaceServiceContext(project.workspaceId, …)`
-- (lib/workspaces/context.ts), which binds `app.workspace_id` and nothing else:
-- no `app.user_id`, no `app.system_admin`. That helper is documented for
-- precisely this shape — "a TRUSTED path that operates within ONE workspace
-- WITHOUT an acting user" — and its security constraint holds, because the id
-- comes from a trusted row lookup rather than from user input.
--
-- Consequence, stated so it is not "fixed" later: an UNBOUND connection sees no
-- `public_follow` row at all. The public changelog page and the Atom feed never
-- read this table, so nothing public regresses; and a carelessly-written query
-- added years from now still cannot enumerate addresses through it.
--
-- `current_setting(..., true)` is missing_ok, so an unset GUC yields NULL, the
-- predicate is NULL, and the row is hidden — no context -> nothing visible,
-- which is the safe failure. The `system_admin` arm is the standard escape for
-- the jobs runtime (the digest sweep in 8.9.7 runs there).
ALTER TABLE "public_follow" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public_follow" FORCE ROW LEVEL SECURITY;

CREATE POLICY "public_follow_workspace_or_system" ON "public_follow"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  );
