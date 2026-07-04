-- CI feedback loop (Story 7.10 · Subtask 7.10.6 / MOTIR-894) — the verification
-- half of the closed loop. Two additions:
--   * `work_item."ciState"` — the per-subtask verification signal the check
--     webhook flips ("passing" / "failing" / NULL); the Story-level "N of M
--     verified" roll-up counts the "passing" leaves. work_item already carries
--     RLS, so a new nullable column needs no policy change.
--   * `github_check_run` — one terminal CI check result per linked PR, unique on
--     (pull_request_id, commit_sha, check_name) so a redelivery / re-run
--     converges on one row and updates its feedback comment in place. Lands WITH
--     its RLS policy (joining through repo → installation to the workspace),
--     mirroring the sibling github_* tables — never an unguarded window.

-- AlterTable
ALTER TABLE "work_item" ADD COLUMN     "ciState" TEXT;

-- CreateTable
CREATE TABLE "github_check_run" (
    "id" TEXT NOT NULL,
    "pull_request_id" TEXT NOT NULL,
    "commit_sha" TEXT NOT NULL,
    "check_name" TEXT NOT NULL,
    "conclusion" TEXT NOT NULL,
    "feedback_comment_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_check_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "github_check_run_pull_request_id_idx" ON "github_check_run"("pull_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "github_check_run_pull_request_id_commit_sha_check_name_key" ON "github_check_run"("pull_request_id", "commit_sha", "check_name");

-- AddForeignKey
ALTER TABLE "github_check_run" ADD CONSTRAINT "github_check_run_pull_request_id_fkey" FOREIGN KEY ("pull_request_id") REFERENCES "github_pull_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_check_run" ADD CONSTRAINT "github_check_run_feedback_comment_id_fkey" FOREIGN KEY ("feedback_comment_id") REFERENCES "comment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security — github_check_run (joins through pull_request → repo →
-- installation). The workspace RLS migration's `ALTER DEFAULT PRIVILEGES … TO
-- prodect_app` auto-grants on every new table the `prodect` role creates, so no
-- explicit GRANT is needed (same as the sibling github_* tables).
-- ===========================================================================
ALTER TABLE "github_check_run" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "github_check_run" FORCE ROW LEVEL SECURITY;

CREATE POLICY "github_check_run_workspace_or_system" ON "github_check_run"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "github_pull_request" p
      JOIN "github_repo" r ON r."id" = p."repo_id"
      JOIN "github_installation" i ON i."id" = r."installation_id"
      WHERE p."id" = "github_check_run"."pull_request_id"
        AND i."workspace_id" = current_setting('app.workspace_id', true)
    )
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "github_pull_request" p
      JOIN "github_repo" r ON r."id" = p."repo_id"
      JOIN "github_installation" i ON i."id" = r."installation_id"
      WHERE p."id" = "github_check_run"."pull_request_id"
        AND i."workspace_id" = current_setting('app.workspace_id', true)
    )
  );
