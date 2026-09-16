-- ============================================================
-- A merge-queue ATTEMPT, and the exit's FAILING CHECK (MOTIR-5633).
-- ============================================================
-- `docs/decisions/approval-gates.md` §4 THIRD AMENDMENT, decision 8. A failed
-- merge-queue check run is reported against the merge group's commit, with
-- `pull_requests: []` and no head branch (MOTIR-5627), so nothing on the check ties
-- it to a pull request. The `merge_group` `checks_requested` delivery does: it
-- carries the group's `head_sha` and a `head_ref` naming `pr-<n>`. Motir records one
-- ATTEMPT per pull request there, before any check can complete; a failed check at
-- that sha writes its name and link onto the attempt (the first to complete wins),
-- and a failure exit copies them from the pull request's latest attempt.
--
-- ⚠️ NOT `github_check_run`. That table is the pull request's OWN CI state at its
-- head; the group's checks say nothing about it, and a red row there would stop a
-- push from re-arming the card's approval.
--
-- `(pull_request_id, head_sha)` is UNIQUE, so a redelivered `checks_requested`
-- writes nothing. `(repo_id, head_sha)` is the lookup a check run makes.
--
-- Both FKs are modelled as Prisma `@relation`s with the same `ON DELETE CASCADE`,
-- so `migrate diff` reports no drift.

-- AlterTable
ALTER TABLE "github_pull_request_queue_exit" ADD COLUMN     "failing_check_name" TEXT,
ADD COLUMN     "failing_check_url" TEXT;

-- CreateTable
CREATE TABLE "github_merge_queue_attempt" (
    "id" TEXT NOT NULL,
    "pull_request_id" TEXT NOT NULL,
    "repo_id" TEXT NOT NULL,
    "head_sha" TEXT NOT NULL,
    "head_ref" TEXT NOT NULL,
    "failing_check_name" TEXT,
    "failing_check_url" TEXT,
    "failed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "github_merge_queue_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "github_merge_queue_attempt_repo_id_head_sha_idx" ON "github_merge_queue_attempt"("repo_id", "head_sha");

-- CreateIndex
CREATE UNIQUE INDEX "github_merge_queue_attempt_pull_request_id_head_sha_key" ON "github_merge_queue_attempt"("pull_request_id", "head_sha");

-- AddForeignKey
ALTER TABLE "github_merge_queue_attempt" ADD CONSTRAINT "github_merge_queue_attempt_pull_request_id_fkey" FOREIGN KEY ("pull_request_id") REFERENCES "github_pull_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_merge_queue_attempt" ADD CONSTRAINT "github_merge_queue_attempt_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "github_repo"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- RLS, in the same migration as the table (no unguarded window). FORCE so even the
-- table-owner role is subject to it. The row carries its repository, so the gate
-- joins `github_repo` directly; the `system_admin` arm admits the webhook path,
-- which resolves the connection tier before any workspace is bound — the policy of
-- `github_pull_request_queue_exit` (20260916190000), one join shorter.
ALTER TABLE "github_merge_queue_attempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "github_merge_queue_attempt" FORCE ROW LEVEL SECURITY;

CREATE POLICY "github_merge_queue_attempt_workspace_or_system" ON "github_merge_queue_attempt"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "github_repo" r
      WHERE r."id" = "github_merge_queue_attempt"."repo_id"
        AND r."workspace_id" = current_setting('app.workspace_id', true)
    )
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "github_repo" r
      WHERE r."id" = "github_merge_queue_attempt"."repo_id"
        AND r."workspace_id" = current_setting('app.workspace_id', true)
    )
  );
