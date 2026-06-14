-- AlterEnum
ALTER TYPE "project_access_level" ADD VALUE 'public';

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "public_overview_md" TEXT;

-- CreateTable
CREATE TABLE "public_request_vote" (
    "id" TEXT NOT NULL,
    "work_item_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "public_request_vote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "public_request_vote_work_item_id_idx" ON "public_request_vote"("work_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "public_request_vote_work_item_id_user_id_key" ON "public_request_vote"("work_item_id", "user_id");

-- AddForeignKey
ALTER TABLE "public_request_vote" ADD CONSTRAINT "public_request_vote_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public_request_vote" ADD CONSTRAINT "public_request_vote_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security — public_request_vote (Story 6.12 · Subtask 6.12.3)
-- ===========================================================================
-- A public-request vote is per-USER and CROSS-ORG: a signed-in account (a
-- non-member of the request's workspace included) upvotes a public request, so
-- the gate CANNOT key on `app.workspace_id` (that would block the very
-- cross-org vote the feature exists for). It keys on the `app.user_id` GUC
-- instead — the api_token precedent — so a voter casts/toggles ONLY their own
-- vote (the write paths, 6.12.6, run under `withUserContext`).
--
-- The aggregate COUNT a request's vote tally needs (the 6.11.3 triage-queue
-- sort key + the public roadmap counts, 6.12.6) spans every voter, so it is
-- read under `withSystemContext` (binding `app.system_admin` to a constant,
-- never user input — the job-ledger / api_token-verify precedent), which the
-- system_admin branch of USING admits. USING governs the owner's SELECT/DELETE;
-- WITH CHECK lets the owner's INSERT land under the non-bypass prodect_app role.
ALTER TABLE "public_request_vote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public_request_vote" FORCE ROW LEVEL SECURITY;

CREATE POLICY "public_request_vote_owner_or_system" ON "public_request_vote"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "user_id" = current_setting('app.user_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "user_id" = current_setting('app.user_id', true)
  );
