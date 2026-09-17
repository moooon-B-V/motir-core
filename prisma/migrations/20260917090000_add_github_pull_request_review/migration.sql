-- ============================================================
-- A GITHUB REVIEW, mirrored (Story MOTIR-4910 · MOTIR-5594).
-- ============================================================
-- `docs/decisions/approval-gates.md` §8 FOURTH AMENDMENT (MOTIR-5590), decisions
-- 2, 4 and 7. A `pull_request_review` delivery writes ONE row here. The evaluator
-- reads them to decide the card's one approve-to-merge gate; the Development block
-- reads them to draw what each pull request's review says while the gate waits.
--
-- ⚠️ `github_review_id` IS THE IDEMPOTENCY KEY, UNIQUE. GitHub's own `review.id`
-- is stable across redeliveries of the same review, so a replayed `submitted`
-- upserts this row rather than writing a second one. A (pull_request, reviewer,
-- commit) key was the alternative and is wrong: a reviewer may legitimately submit
-- two reviews at one head, and collapsing them would lose the later one.
--
-- ⚠️ ALL FOUR STATES ARE STORED, including the two that never decide anything.
-- `commented` never counts, and `dismissed` is a review that was withdrawn — but
-- the Development block DRAWS a review that does not count (an approval at an
-- earlier commit, Panel G2 of design § 23), and a row that was never written
-- cannot be drawn. Counting is a property of the (state, commit, dismissal,
-- permission) tuple read at evaluation time, never of `state` alone.
--
-- ⚠️ ROWS ARE RECORDED WHETHER OR NOT A GATE EXISTS (decision 8). A review given
-- while CI was still running has no gate to be applied to yet; storing it anyway
-- is what lets the gate, once raised, be decided from reviews that predate it
-- rather than asking the reviewer again.
--
-- ⚠️ `reviewer_permission = 'unknown'` MEANS IT COULD NOT BE READ, and is NOT a
-- synonym for `none`. A review whose permission is unknown counts for nothing, but
-- it must stay distinguishable from a reviewer positively known to have no access.
--
-- The FK is modelled as a Prisma `@relation` on both sides with the same
-- `ON DELETE CASCADE`, so `migrate diff` reports no drift.

-- CreateEnum
CREATE TYPE "github_review_state" AS ENUM ('approved', 'changes_requested', 'commented', 'dismissed');

-- CreateEnum
CREATE TYPE "github_repository_permission" AS ENUM ('admin', 'maintain', 'write', 'triage', 'read', 'none', 'unknown');

-- AlterEnum
-- Authority conferred by the HOST'S review permission (decision 4). Additive, and
-- safe in one deploy because nothing reads it yet: the decide door that writes it
-- ships in a later card on this same branch.
ALTER TYPE "approval_gate_authority" ADD VALUE IF NOT EXISTS 'github_review';

-- CreateTable
CREATE TABLE "github_pull_request_review" (
    "id" TEXT NOT NULL,
    "github_review_id" TEXT NOT NULL,
    "github_pull_request_id" TEXT NOT NULL,
    "reviewer_github_user_id" TEXT NOT NULL,
    "reviewer_login" TEXT NOT NULL,
    "reviewer_type" TEXT NOT NULL,
    "state" "github_review_state" NOT NULL,
    "commit_sha" TEXT NOT NULL,
    "reviewer_permission" "github_repository_permission" NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL,
    "html_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_pull_request_review_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "github_pull_request_review_github_review_id_key" ON "github_pull_request_review"("github_review_id");

-- CreateIndex
-- ⚠️ NAMED EXPLICITLY, and under 63 characters. The derived name would be 64, and
-- Postgres and Prisma truncate it differently, which `migrate diff` then reports as
-- a permanent spurious RENAME and the build job fails on.
CREATE INDEX "github_pr_review_pr_id_commit_sha_idx" ON "github_pull_request_review"("github_pull_request_id", "commit_sha");

-- AddForeignKey
ALTER TABLE "github_pull_request_review" ADD CONSTRAINT "github_pull_request_review_github_pull_request_id_fkey" FOREIGN KEY ("github_pull_request_id") REFERENCES "github_pull_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS, in the same migration as the table (no unguarded window). FORCE so even the
-- table-owner role is subject to it. The gate is `github_pull_request_queue_exit`'s
-- (20260916190000), itself `github_ci_feedback_comment`'s (20260828190000), and it
-- is copied here for the same reason: this row hangs off a pull request and has no
-- tenant column of its own, and RLS does not traverse foreign keys, so the policy
-- joins through `github_pull_request → github_repo` explicitly. The `system_admin`
-- arm admits the webhook path, which resolves the connection tier before any
-- workspace is bound. The owner role's default privileges already grant `motir_app`
-- on every new table.
ALTER TABLE "github_pull_request_review" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "github_pull_request_review" FORCE ROW LEVEL SECURITY;

CREATE POLICY "github_pull_request_review_workspace_or_system" ON "github_pull_request_review"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "github_pull_request" p
      JOIN "github_repo" r ON r."id" = p."repo_id"
      WHERE p."id" = "github_pull_request_review"."github_pull_request_id"
        AND r."workspace_id" = current_setting('app.workspace_id', true)
    )
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "github_pull_request" p
      JOIN "github_repo" r ON r."id" = p."repo_id"
      WHERE p."id" = "github_pull_request_review"."github_pull_request_id"
        AND r."workspace_id" = current_setting('app.workspace_id', true)
    )
  );
